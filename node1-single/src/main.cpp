#include <Arduino.h>
#include <WiFi.h>
#include <WiFiMulti.h>
#include <WebServer.h>
#include <ESPmDNS.h>
#include <Wire.h>
#include <ArduinoJson.h>
#include <Adafruit_AHTX0.h>
#include <Adafruit_BMP085.h>
#include "config.h"

WiFiMulti wifi;
WebServer api(80);
HardwareSerial modem(2);
Adafruit_AHTX0 aht;
Adafruit_BMP085 bmp;

volatile uint32_t bucketCount=0, windCount=0, bucketEdgeUs=0, windEdgeUs=0;
void IRAM_ATTR onBucket() {
  uint32_t now=micros();
  if ((uint32_t)(now-bucketEdgeUs)>120000) { bucketCount++; bucketEdgeUs=now; }
}
void IRAM_ATTR onWind() {
  uint32_t now=micros();
  if ((uint32_t)(now-windEdgeUs)>8000) { windCount++; windEdgeUs=now; }
}

enum PumpState { IDLE, FILL, DRAIN, WAIT, FAULT };
PumpState mode=IDLE, requested=IDLE;
const char* modeName(PumpState m) {
  switch(m) {case IDLE:return "IDLE";case FILL:return "FILL";
    case DRAIN:return "DRAIN";case WAIT:return "WAIT";default:return "FAULT";}
}
String fault="";
uint32_t lastBucket=0, previousTips=0, previousWind=0, lastSample=0;
uint32_t aiAt=0, aiSeq=0, modeAt=0, offAt=0, lastWifiCheck=0;
uint32_t modemSeq=0;
bool latchedFault=false;
float aiLevel=NAN, aiConfidence=0, jsnLevel=NAN, temp=NAN, humidity=NAN, pressure=NAN, windRpm=0;
bool aiFlag=false, ahtOk=false, bmpOk=false, jsnOk=false, rainPlate=false, raining=false;
uint32_t tipsNow=0,tipsSample=0,windNow=0;
SemaphoreHandle_t sensorLock;

void setPumps(bool input, bool output) {
  if(!ENABLE_PUMPS) {input=false;output=false;}
  if(input && output) {input=false;output=false;}
  digitalWrite(PUMP_IN_PIN, (input==bool(MOSFET_ACTIVE_HIGH))?HIGH:LOW);
  digitalWrite(PUMP_OUT_PIN,(output==bool(MOSFET_ACTIVE_HIGH))?HIGH:LOW);
}
void enter(PumpState next,const String& reason="") {
  if (mode==next) return;
  setPumps(false,false);
  offAt=millis();
  mode=next;
  modeAt=millis();
  if(next==FAULT) {fault=reason; if(reason.endsWith("_TIMEOUT")) latchedFault=true;}
  Serial.printf("MODE=%s %s\n",modeName(mode),fault.c_str());
}
float readLevel() {
  digitalWrite(JSN_TRIG,LOW);delayMicroseconds(3);
  digitalWrite(JSN_TRIG,HIGH);delayMicroseconds(10);digitalWrite(JSN_TRIG,LOW);
  uint32_t us=pulseIn(JSN_ECHO,HIGH,26000);
  if(us==0)return NAN;
  float distance=us*0.0343f/2;
  if(distance<2||distance>450)return NAN;
  float level=JSN_SENSOR_HEIGHT_CM-distance;
  return level>=-1 && level<=18 ? max(0.0f,level):NAN;
}
bool aiFresh(uint32_t now) {
  return aiFlag && (uint32_t)(now-aiAt)<AI_TIMEOUT_MS &&
    isfinite(aiLevel) && aiLevel>=0 && aiLevel<=10;
}
void onAi() {
  if (!api.hasHeader("X-Node-Key") || api.header("X-Node-Key")!=String(NODE_AI_KEY)) {
    api.send(401,"application/json","{\"error\":\"unauthorized\"}"); return;
  }
  JsonDocument doc;
  if(deserializeJson(doc,api.arg("plain"))) {
    api.send(400,"application/json","{\"error\":\"bad_json\"}");return;
  }
  uint32_t seq=doc["seq"]|0UL;
  bool valid=doc["valid"]|false;
  float value=doc["level_cm"]|(-1.0f);
  float conf=doc["confidence"]|(-1.0f);
  if(!seq || (aiAt && (int32_t)(seq-aiSeq)<=0)) {
    api.send(409,"application/json","{\"error\":\"old_seq\"}");return;
  }
  aiSeq=seq;
  aiAt=millis();
  aiLevel=value;
  aiConfidence=conf;
  aiFlag=valid && isfinite(value)&&value>=0&&value<=10 &&
         isfinite(conf)&&conf>=AI_MIN_CONFIDENCE&&conf<=1;
  api.send(200,"application/json",aiFlag?"{\"ok\":true}":"{\"ok\":false,\"reason\":\"invalid_ai\"}");
}
void onReset() {
  if (!api.hasHeader("X-Node-Key") || api.header("X-Node-Key")!=String(NODE_AI_KEY)) {
    api.send(401,"text/plain","unauthorized");return;
  }
  latchedFault=false;fault="";enter(WAIT);
  api.send(200,"application/json","{\"ok\":true}");
}
void onStatus() {
  JsonDocument d;
  d["mode"]=modeName(mode);
  d["aiValid"]=aiFresh(millis());
  if(aiFresh(millis()))d["aiLevelCm"]=aiLevel;
  d["raining"]=raining;d["tips"]=tipsNow;d["fault"]=fault;
  String out;serializeJson(d,out);
  api.sendHeader("Cache-Control","no-store");
  api.send(200,"application/json",out);
}
void sampleSensors(uint32_t now) {
  noInterrupts();
  uint32_t b=bucketCount,w=windCount;
  interrupts();
  if(b!=tipsNow){tipsNow=b;lastBucket=now;}
  tipsSample=b-previousTips;
  previousTips=b;
  raining=lastBucket && ((uint32_t)(now-lastBucket)<RAIN_STOP_MS);
  uint32_t dt=now-lastSample;
  if(dt==0)dt=1;
  windRpm=(w-previousWind)*60000.0f/dt;
  previousWind=w;
  windNow=w;
  rainPlate=(digitalRead(RAIN_PLATE_PIN)==LOW);
  float value=readLevel();
  jsnOk=isfinite(value);
  jsnLevel=value;
  if(ahtOk){
    sensors_event_t h,t;
    aht.getEvent(&h,&t);
    temp=t.temperature;humidity=h.relative_humidity;
  }
  if(bmpOk)pressure=bmp.readPressure()/100.0f;
  lastSample=now;
}
void controlPumps(uint32_t now) {
  bool ready=aiFresh(now);
  bool unsafeJs = jsnOk && jsnLevel>=MAX_WATER_CM+0.5f;
  bool conflicting=ready && jsnOk && fabsf(jsnLevel-aiLevel)>3.0f;
  if(latchedFault) {setPumps(false,false);return;}
  if(!ready || unsafeJs || conflicting){
    if(mode!=FAULT)enter(FAULT,!ready?"AI_STALE_OR_INVALID":unsafeJs?"JSN_HIGH":"SENSOR_CONFLICT");
    setPumps(false,false);return;
  }
  if(mode==FAULT){fault="";enter(WAIT);}
  PumpState target=IDLE;
  if(raining && aiLevel<MAX_WATER_CM-0.2f)target=FILL;
  if(!raining && aiLevel>MIN_WATER_CM+0.2f)target=DRAIN;
  if(mode==FILL && (uint32_t)(now-modeAt)>MAX_FILL_MS) {
    enter(FAULT,"FILL_TIMEOUT");return;
  }
  if(mode==DRAIN && (uint32_t)(now-modeAt)>MAX_DRAIN_MS) {
    enter(FAULT,"DRAIN_TIMEOUT");return;
  }
  if(mode==FILL && (target!=FILL)){enter(WAIT);}
  if(mode==DRAIN && (target!=DRAIN)){enter(WAIT);}
  if(mode==WAIT) {
    if((uint32_t)(now-offAt)<PUMP_DEADTIME_MS){setPumps(false,false);return;}
    if(target!=IDLE) enter(target);
    else enter(IDLE);
  } else if(mode!=target) {
    enter(WAIT);
    setPumps(false,false);return;
  }
  setPumps(mode==FILL,mode==DRAIN);
}

// LTE management ported from Central v1.6.2: check SIM/registration before HTTP.
// Run ALL AT commands only in modemTask (UART2 has one owner).
bool networkReady=false;
uint32_t lastNetworkCheck=0;
uint8_t failedUploads=0;

bool waitModem(const char* expected,uint32_t timeout,String* response=nullptr) {
  String buff;
  uint32_t start=millis();
  while((uint32_t)(millis()-start)<timeout){
    while(modem.available()){
      char ch=(char)modem.read();
      if(buff.length()<2000) buff+=ch; else buff.remove(0,500);
      if(buff.indexOf(expected)>=0) {
        if(response)*response=buff;
        return true;
      }
      if(buff.indexOf("\r\nERROR")>=0 || buff.indexOf("+CME ERROR:")>=0 ||
         buff.indexOf("+CMS ERROR:")>=0) {
        if(response)*response=buff;
        return false;
      }
    }
    vTaskDelay(pdMS_TO_TICKS(5));
  }
  if(response)*response=buff;
  return false;
}
bool command(const String &cmd,const char* expect="OK",uint32_t ms=3000){
  while(modem.available())modem.read();
  modem.println(cmd);
  String answer;
  bool ok=waitModem(expect,ms,&answer);
  // Never log HTTPPARA USERDATA: it contains the secret API key.
  const bool secret=cmd.indexOf("USERDATA")>=0;
  Serial.printf("[SIM] %s : %s\n",secret?"HTTP USERDATA (hidden)":cmd.c_str(),
                ok?"OK":"FAILED");
  if(!ok && !answer.isEmpty()) {
    answer.trim();
    Serial.printf("[SIM] response: %s\n",answer.c_str());
  }
  return ok;
}
bool registrationOk(const String& res) {
  int p=res.indexOf("+CEREG:");
  if(p<0)return false;
  int end=res.indexOf('\n',p);
  String row=res.substring(p,end<0?res.length():end);
  row.trim();
  // +CEREG: <n>,<stat> OR +CEREG: <stat>
  int col=row.indexOf(':');
  int comma=row.indexOf(',',col+1);
  String stat=comma>=0?row.substring(comma+1):row.substring(col+1);
  stat.trim();
  return stat.startsWith("1") || stat.startsWith("5");
}
bool queryRegistration() {
  while(modem.available())modem.read();
  modem.println("AT+CEREG?");
  String res;
  bool ok=waitModem("OK",2000,&res);
  Serial.printf("[LTE] CEREG: %s\n",ok?res.c_str():"no response");
  return ok && registrationOk(res);
}
bool prepareNetwork() {
  bool responding=false;
  for(int i=0;i<3;i++){
    if(command("AT","OK",1200)){responding=true;break;}
    vTaskDelay(pdMS_TO_TICKS(250));
  }
  if(!responding)return false;
  command("ATE0","OK",1500);
  // CPIN MUST be READY. This prevents HTTP failures with an inactive SIM.
  if(!command("AT+CPIN?","READY",2000))return false;
  String apn=String("AT+CGDCONT=1,\"IP\",\"")+NODE_APN+"\"";
  if(!command(apn,"OK",3000))return false;
  // Same registration/attachment strategy as working Central project.
  command("AT+CGATT=1","OK",8000);
  uint32_t started=millis();
  while((uint32_t)(millis()-started)<SIM_REGISTER_WAIT_MS){
    if(queryRegistration()){
      command("AT+CSQ","OK",1500);
      lastNetworkCheck=millis();
      Serial.println("[LTE] Registered, APN ready");
      return true;
    }
    vTaskDelay(pdMS_TO_TICKS(1000));
  }
  Serial.println("[LTE] Registration timed out");
  return false;
}

String payload() {
  JsonDocument d;
  xSemaphoreTake(sensorLock,portMAX_DELAY);
  d["nodeId"]=1;d["seq"]=++modemSeq;d["uptimeMs"]=millis();
  if(isfinite(temp))d["temperatureC"]=temp;
  if(isfinite(humidity))d["humidityPct"]=humidity;
  if(isfinite(pressure))d["pressureHpa"]=pressure;
  d["windRpm"]=windRpm;d["rainTipsTotal"]=tipsNow;
  d["rainTipsInterval"]=tipsSample;
  d["raining"]=raining;d["rainPlateWet"]=rainPlate;
  if(jsnOk)d["jsnLevelCm"]=jsnLevel;
  bool fresh=aiFresh(millis());
  if(fresh)d["aiLevelCm"]=aiLevel;
  d["aiValid"]=fresh;
  d["mode"]=modeName(mode);d["pumpIn"]=mode==FILL&&ENABLE_PUMPS;
  d["pumpOut"]=mode==DRAIN&&ENABLE_PUMPS;
  d["fault"]=fault;d["wifiConnected"]=WiFi.isConnected();
  xSemaphoreGive(sensorLock);
  String out;serializeJson(d,out);return out;
}
bool send4G(const String& body) {
  // HTTPTERM may answer ERROR when HTTP has not been initialized.
  // This is expected and must not be treated as modem failure.
  command("AT+HTTPTERM","OK",1200);
  if(!command("AT+HTTPINIT","OK",10000))return false;

  bool ok=true;
  // Render hosts several HTTPS domains on the same server: SNI is required.
  // Force TLS 1.2; do not silently downgrade to insecure HTTP.
  ok=ok && command("AT+CSSLCFG=\"sslversion\",0,3","OK",3000);
  ok=ok && command("AT+CSSLCFG=\"enableSNI\",0,1","OK",3000);
  ok=ok && command("AT+HTTPPARA=\"SSLCFG\",0","OK",3000);
  ok=ok && command("AT+HTTPPARA=\"CID\",1","OK",3000);
  ok=ok && command("AT+HTTPPARA=\"URL\",\""+String(NODE_UPLOAD_URL)+"\"","OK",4000);
  ok=ok && command("AT+HTTPPARA=\"CONTENT\",\"application/json\"","OK",3000);
  ok=ok && command("AT+HTTPPARA=\"USERDATA\",\"X-Node-Key: "+String(NODE_UPLOAD_KEY)+"\"","OK",3000);
  if(ok){
    while(modem.available())modem.read();
    modem.printf("AT+HTTPDATA=%u,10000\r\n",(unsigned)body.length());
    ok=waitModem("DOWNLOAD",8000);
    if(ok){
      modem.print(body);
      String response;
      ok=waitModem("OK",15000,&response);
      if(!ok)Serial.printf("[LTE] HTTPDATA failed: %s\n",response.c_str());
    }else Serial.println("[LTE] HTTPDATA: DOWNLOAD timeout");
  }
  if(ok){
    while(modem.available())modem.read();
    modem.println("AT+HTTPACTION=1");
    String result;
    ok=waitModem("+HTTPACTION:",45000,&result);
    if(ok){
      int p=result.indexOf("+HTTPACTION:");
      int comma=result.indexOf(',',p);
      int code=comma>=0?result.substring(comma+1,comma+4).toInt():0;
      Serial.printf("[LTE] HTTPACTION status=%d\n",code);
      if(code==715)Serial.println("[LTE] TLS handshake failed: check SSL/SNI, TLS compatibility, modem clock/firmware");
      ok=code>=200 && code<300;
    } else {
      Serial.printf("[LTE] HTTPACTION timeout/error: %s\n",result.c_str());
    }
  }
  command("AT+HTTPTERM","OK",3000);
  return ok;
}
void modemTask(void*) {
  vTaskDelay(pdMS_TO_TICKS(1500)); // allow SIM UART to settle after boot
  for(;;){
    if(ENABLE_4G_UPLOAD) {
      if(!networkReady){
        Serial.println("[LTE] Initialize / reconnect Wintel data session");
        networkReady=prepareNetwork();
        failedUploads=0;
      }
      if(networkReady){
        // Check registration every 30 seconds, not on every HTTP POST.
        if((uint32_t)(millis()-lastNetworkCheck)>=SIM_NETWORK_CHECK_MS){
          lastNetworkCheck=millis();
          if(!queryRegistration()){
            Serial.println("[LTE] Registration lost, reconnecting");
            networkReady=false;
          }
        }
      }
      if(networkReady){
        String body=payload();
        bool result=send4G(body);
        Serial.printf("Node1 -> Render: %s, seq=%lu\n",result?"OK":"FAILED",(unsigned long)modemSeq);
        if(result)failedUploads=0;
        else if(++failedUploads>=3) {
          Serial.println("[LTE] 3 upload failures; refresh network state");
          networkReady=false;
        }
      }
    }
    vTaskDelay(pdMS_TO_TICKS(10000));
  }
}
void setup() {
  Serial.begin(115200);
  pinMode(PUMP_IN_PIN,OUTPUT);pinMode(PUMP_OUT_PIN,OUTPUT);
  setPumps(false,false);
  pinMode(BUCKET_PIN,INPUT_PULLUP);pinMode(WIND_PIN,INPUT_PULLUP);
  pinMode(RAIN_PLATE_PIN,INPUT_PULLUP);
  pinMode(JSN_TRIG,OUTPUT);pinMode(JSN_ECHO,INPUT);
  attachInterrupt(digitalPinToInterrupt(BUCKET_PIN),onBucket,FALLING);
  attachInterrupt(digitalPinToInterrupt(WIND_PIN),onWind,FALLING);
  Wire.begin(I2C_SDA,I2C_SCL);
  ahtOk=aht.begin();bmpOk=bmp.begin();
  sensorLock=xSemaphoreCreateMutex();
  WiFi.mode(WIFI_STA);
  wifi.addAP(WIFI_SSID_1,WIFI_PASS_1);
  wifi.addAP(WIFI_SSID_2,WIFI_PASS_2);
  const char* headers[]={"X-Node-Key"};
  api.collectHeaders(headers,1);
  api.on("/ai",HTTP_POST,onAi);
  api.on("/status",HTTP_GET,onStatus);
  api.on("/reset",HTTP_POST,onReset);
  api.begin();
  modem.begin(SIM_BAUD,SERIAL_8N1,SIM_RX,SIM_TX);
  xTaskCreatePinnedToCore(modemTask,"lte",8192,nullptr,1,nullptr,0);
  lastSample=millis();
  Serial.println("FloodGuard Node1 ready - pumps OFF until valid AI");
}
void loop() {
  uint32_t now=millis();
  if((uint32_t)(now-lastWifiCheck)>3000){
    lastWifiCheck=now;
    bool was=WiFi.isConnected();
    wifi.run(500);
    if(!was && WiFi.isConnected()){
      MDNS.begin("floodguard-node1");
      MDNS.addService("http","tcp",80);
      Serial.print("Node1 IP: ");Serial.println(WiFi.localIP());
    }
  }
  api.handleClient();
  if((uint32_t)(now-lastSample)>=1000) {
    xSemaphoreTake(sensorLock,portMAX_DELAY);
    sampleSensors(now);
    xSemaphoreGive(sensorLock);
  }
  xSemaphoreTake(sensorLock,portMAX_DELAY);
  controlPumps(now);
  xSemaphoreGive(sensorLock);
  delay(20);
}
