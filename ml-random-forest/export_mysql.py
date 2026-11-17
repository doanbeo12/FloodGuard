"""Export a labelled experiment window from existing FloodGuard MySQL to RF CSV.

Example:
python export_mysql.py --session demo_dry_01 --start "2026-11-17 16:00:00" --end "2026-11-17 17:20:00"
Dates are UTC. Runs on laptop with credentials, no private DB download via Render.
"""
import argparse
import csv
import getpass
import os
from pathlib import Path
import pymysql

FIELDS=["session","at_ms","seq","nodeId","temperatureC","humidityPct",
 "pressureHpa","windRpm","rainTipsTotal","rainTipsInterval",
 "rainPlateWet","raining","aiLevelCm","aiValid","jsnLevelCm",
 "pumpIn","pumpOut","mode"]

SQL="""
SELECT
  UNIX_TIMESTAMP(received_at)*1000 AS at_ms, seq, node_id,
  temperature_c,humidity_pct,pressure_hpa,wind_rpm,
  rain_tips_total,rain_tips_interval,rain_plate_wet,raining,
  ai_level_cm,ai_valid,jsn_level_cm,pump_in,pump_out,mode
FROM node1_telemetry
WHERE received_at >= %s AND received_at < %s AND node_id=1
ORDER BY received_at ASC, id ASC
"""

def main():
    p=argparse.ArgumentParser()
    p.add_argument("--session",required=True)
    p.add_argument("--start",required=True,help="UTC YYYY-MM-DD HH:MM:SS")
    p.add_argument("--end",required=True,help="UTC YYYY-MM-DD HH:MM:SS")
    p.add_argument("--out",default="data")
    args=p.parse_args()
    if not args.session.replace("-","").replace("_","").isalnum():
        p.error("Invalid session identifier")
    host=os.environ.get("DB_HOST")
    user=os.environ.get("DB_USER")
    database=os.environ.get("DB_NAME")
    if not host or not user or not database:
        p.error("Set DB_HOST, DB_USER, DB_NAME to the working MySQL connection from DBeaver")
    password=os.environ.get("DB_PASSWORD") or getpass.getpass("MySQL password: ")
    port=int(os.environ.get("DB_PORT","3306"))
    conn=pymysql.connect(host=host,port=port,user=user,password=password,
        database=database,charset="utf8mb4",connect_timeout=10,
        cursorclass=pymysql.cursors.DictCursor,read_timeout=30,
        ssl={"check_hostname":True} if os.environ.get("DB_SSL","false").lower()=="true" else None)
    outpath=Path(args.out)/(args.session+".csv")
    outpath.parent.mkdir(parents=True,exist_ok=True)
    count=0
    try:
        with conn.cursor() as cur:
            cur.execute("SET time_zone = '+00:00'")
            cur.execute(SQL,(args.start,args.end))
            with outpath.open("w",newline="",encoding="utf-8") as fp:
                writer=csv.DictWriter(fp,fieldnames=FIELDS)
                writer.writeheader()
                while True:
                    rows=cur.fetchmany(1000)
                    if not rows:break
                    for d in rows:
                        writer.writerow({
                            "session":args.session,"at_ms":int(d["at_ms"]),
                            "seq":d["seq"],"nodeId":d["node_id"],
                            "temperatureC":d["temperature_c"],"humidityPct":d["humidity_pct"],
                            "pressureHpa":d["pressure_hpa"],"windRpm":d["wind_rpm"],
                            "rainTipsTotal":d["rain_tips_total"],
                            "rainTipsInterval":d["rain_tips_interval"],
                            "rainPlateWet":d["rain_plate_wet"],"raining":d["raining"],
                            "aiLevelCm":d["ai_level_cm"] if d["ai_valid"] else "",
                            "aiValid":d["ai_valid"],"jsnLevelCm":d["jsn_level_cm"],
                            "pumpIn":d["pump_in"],"pumpOut":d["pump_out"],"mode":d["mode"]
                        })
                        count+=1
    finally:
        conn.close()
    print(f"Exported {count} records to {outpath}")
    if not count:
        print("No records in window; check timezone and MySQL table. CSV has header only.")

if __name__=="__main__":
    main()
