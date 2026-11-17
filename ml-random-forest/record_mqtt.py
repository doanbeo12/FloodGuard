"""Record raw Node 1 MQTT telemetry locally for Random Forest training.

Usage:
  python record_mqtt.py --session "demo_rain_01"
  # Ctrl+C to finish this independent recording session.

Only sensor measurements are recorded. Don't use the public broker for secrets.
"""
import argparse
import csv
from datetime import datetime, timezone
import json
from pathlib import Path

import paho.mqtt.client as mqtt

FIELDS = [
    "session", "at_ms", "seq", "nodeId", "temperatureC", "humidityPct",
    "pressureHpa", "windRpm", "rainTipsTotal", "rainTipsInterval",
    "rainPlateWet", "raining", "aiLevelCm", "aiValid", "jsnLevelCm",
    "pumpIn", "pumpOut", "mode"
]

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--session", required=True, help="Unique capture session identifier")
    ap.add_argument("--host", default="broker.hivemq.com")
    ap.add_argument("--port", type=int, default=1883)
    ap.add_argument("--topic", default="flood-monitoring/floodguard-doanbeo12/node1-telemetry-v3")
    ap.add_argument("--out", default="data")
    args=ap.parse_args()
    if not args.session.replace("-","").replace("_","").isalnum():
        ap.error("session must contain only letters, digits, - and _")
    path=Path(args.out) / (args.session + ".csv")
    path.parent.mkdir(parents=True,exist_ok=True)
    created=not path.exists() or path.stat().st_size==0
    out=path.open("a",newline="",encoding="utf-8")
    writer=csv.DictWriter(out,fieldnames=FIELDS)
    if created:writer.writeheader()
    total=0

    def on_connect(client,userdata,flags,reason_code,properties):
        print("MQTT status:",reason_code, flush=True)
        if not reason_code.is_failure:
            client.subscribe(args.topic,qos=0)

    def on_message(client,userdata,msg):
        nonlocal total
        if msg.topic!=args.topic or len(msg.payload)>3072:return
        try:
            data=json.loads(msg.payload)
            if data.get("nodeId")!=1:return
            record={k:data.get(k) for k in FIELDS}
            record["session"]=args.session
            record["at_ms"]=int(datetime.now(timezone.utc).timestamp()*1000)
            # Never write an obsolete cached AI value as a valid training label.
            if data.get("aiValid") is not True:record["aiLevelCm"]=None
            writer.writerow(record)
            out.flush()
            total+=1
            if total%10==1:
                print("Saved",total,"records ->",path,flush=True)
        except (ValueError,TypeError,KeyError) as exc:
            print("Ignored invalid record:",exc,flush=True)

    try:
        client=mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
        client.on_connect=on_connect
        client.on_message=on_message
        client.connect(args.host,args.port,keepalive=60)
        print("Recording",args.topic,"to",path,flush=True)
        client.loop_forever()
    except KeyboardInterrupt:
        print("\nStopped. Total records:",total)
    finally:
        out.close()

if __name__=="__main__":
    main()
