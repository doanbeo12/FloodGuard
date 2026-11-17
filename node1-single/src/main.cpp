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
  windRpm=(w-previousWind)*60000.0f/max(1UL,now-lastSample);
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

bool waitModem(const char* expected,uint32_t timeout,String* response=nullptr) {
  String buff;uint32_t start=millis();
  while((uint32_t)(millis()-start)<timeout){
    while(modem.available()){
      char ch=modem.read();
      if(buff.length()<1600)buff+=ch;else buff.remove(0,500);
      if(buff.indexOf(expected)>=0){if(response)*response=buff;return true;}
      if(buff.indexOf("\r\nERROR")>=0){if(response)*response=buff;return false;}
    }
    vTaskDelay(pdMS_TO_TICKS(10));
  }
  if(response)*response=buff;
  return false;
}
bool command(const String &cmd,const char* expect="OK",uint32_t ms=3000){
  while(modem.available())modem.read();
  modem.println(cmd);
  return waitModem(expect,ms);
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
  if(!command("AT")) return false;
  command("AT+HTTPTERM","OK",1000);
  if(!command("AT+CGDCONT=1,\"IP\",\""+String(NODE_APN)+"\""))return false;
  if(!command("AT+HTTPINIT","OK",15000))return false;
  bool ok=command("AT+HTTPPARA=\"URL\",\""+String(NODE_UPLOAD_URL)+"\"") &&
    command("AT+HTTPPARA=\"CONTENT\",\"application/json\"") &&
    command("AT+HTTPPARA=\"USERDATA\",\"X-Node-Key: "+String(NODE_UPLOAD_KEY)+"\"");
  if(ok){
    while(modem.available())modem.read();
    modem.printf("AT+HTTPDATA=%u,10000\r\n",(unsigned)body.length());
    ok=waitModem("DOWNLOAD",6000);
    if(ok){
      modem.print(body);
      ok=waitModem("OK",12000);
    }
  }
  if(ok){
    while(modem.available())modem.read();
    modem.println("AT+HTTPACTION=1");
    String result;
    ok=waitModem("+HTTPACTION:",25000,&result);
    if(ok){
      int idx=result.indexOf("+HTTPACTION:");
      int comma=result.indexOf(',',idx);
      int code=comma>0?result.substring(comma+1,comma+4).toInt():0;
      ok=code>=200&&code<300;
      Serial.printf("4G HTTP status=%d\n",code);
    }
  }
  command("AT+HTTPTERM","OK",3000);
  return ok;
}
void modemTask(void*) {
  for(;;){
    if(ENABLE_4G_UPLOAD){
      String body=payload();
      bool result=send4G(body);
      Serial.printf("4G telemetry %s\n",result?"OK":"FAILED");
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
