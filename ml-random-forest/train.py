"""Train Random Forest classifiers on real FloodGuard sensor sessions.

Do not train on fabricated labels or randomly split near-duplicate time samples.
Output JSON contains tree structure; Node.js reads it without scikit-learn.
"""
import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import accuracy_score, balanced_accuracy_score, f1_score, precision_score, recall_score, roc_auc_score
from sklearn.model_selection import GroupShuffleSplit

FEATURES = [
    "temperatureC", "humidityPct", "pressureHpa", "windRpm", "rainTipsInterval",
    "aiLevelCm", "pressureSlope2m", "humiditySlope2m", "temperatureSlope2m",
    "windMean2m", "rainTips2m", "waterSlope2m", "rainingNow", "rainPlateWet",
]
SENTINEL = -999.0
HORIZONS_MIN = {"rain1":1, "rain2":2, "rain3":3, "flood3":3}
COLUMNS = [
    "session","at_ms","seq","nodeId","temperatureC","humidityPct","pressureHpa",
    "windRpm","rainTipsTotal","rainTipsInterval","rainPlateWet","raining",
    "aiLevelCm","aiValid","jsnLevelCm"
]

def number(x):
    try:
        n=float(x)
        return n if np.isfinite(n) else SENTINEL
    except (TypeError,ValueError):
        return SENTINEL

def flag(x):
    return str(x).lower() in ("true","1","yes")

def slope(window,key):
    valid=window[window[key].notna()]
    if len(valid)<3 or valid.at_ms.iloc[-1]-valid.at_ms.iloc[0]<90000:
        return SENTINEL
    mid=len(valid)//2
    a,b=valid.iloc[:mid],valid.iloc[mid:]
    delta=(b.at_ms.mean()-a.at_ms.mean())/60000
    return float((b[key].mean()-a[key].mean())/delta) if delta>0.1 else SENTINEL

def build_features(g,i):
    now=int(g.at_ms.iloc[i])
    w=g[(g.at_ms<=now)&(g.at_ms>=now-120000)]
    if len(w)<8 or now-int(w.at_ms.iloc[0])<90000:return None
    if w.at_ms.diff().dropna().max()>45000:return None
    r=g.iloc[i]
    def num_col(k):return number(r[k])
    def slope_col(k):return slope(w,k)
    wind=w.windRpm.dropna()
    rainfall=w.rainTipsInterval.fillna(0).clip(0,10000).sum()
    features={
        "temperatureC":num_col("temperatureC"),
        "humidityPct":num_col("humidityPct"),
        "pressureHpa":num_col("pressureHpa"),
        "windRpm":num_col("windRpm"),
        "rainTipsInterval":num_col("rainTipsInterval"),
        "aiLevelCm":num_col("aiLevelCm") if flag(r.aiValid) else SENTINEL,
        "pressureSlope2m":slope_col("pressureHpa"),
        "humiditySlope2m":slope_col("humidityPct"),
        "temperatureSlope2m":slope_col("temperatureC"),
        "windMean2m":float(wind.mean()) if len(wind) else SENTINEL,
        "rainTips2m":float(rainfall),
        "waterSlope2m":slope_col("aiLevelCm"),
        "rainingNow":int(flag(r.raining)),
        "rainPlateWet":int(flag(r.rainPlateWet)),
    }
    return np.asarray([features[k] for k in FEATURES], dtype=np.float32)

def future_covered(part,start,end):
    if len(part)<3:return False
    if int(part.at_ms.iloc[0])-start>30000 or end-int(part.at_ms.iloc[-1])>30000:
        return False
    return not (part.at_ms.diff().dropna()>45000).any()

def target(g,i,name):
    now=int(g.at_ms.iloc[i])
    t=int(HORIZONS_MIN[name]*60000)
    if name.startswith("rain"):
        # Predict FUTURE rain onset; current rain already detected, not predicted.
        if flag(g.raining.iloc[i]) or flag(g.rainPlateWet.iloc[i]):return None
        window=g[(g.at_ms>now)&(g.at_ms<=now+t)]
        if not future_covered(window,now,now+t):return None
        return int(any(flag(x) for x in window.raining) or
                   any(flag(x) for x in window.rainPlateWet))
    if name=="flood3":
        if pd.isna(g.aiLevelCm.iloc[i]):return None
        window=g[(g.at_ms>=now)&(g.at_ms<=now+t)]
        valid=window[window.aiLevelCm.notna()]
        if not future_covered(valid,now,now+t):return None
        return int((valid.aiLevelCm>=7.0).any())

def export_tree(est):
    t=est.tree_
    # sklearn tree value can be counts (old version) or proportions (new).
    leaf_probs=[]
    for node in range(t.node_count):
        vals=t.value[node,0]
        den=float(np.sum(vals))
        classes=est.classes_.tolist()
        j=classes.index(1) if 1 in classes else None
        leaf_probs.append(round(float(vals[j]/den),7) if j is not None and den else 0.0)
    return {
        "left":t.children_left.tolist(),"right":t.children_right.tolist(),
        "feature":t.feature.tolist(),
        "threshold":[round(float(x),7) for x in t.threshold.tolist()],
        "p1":leaf_probs
    }

def load_sessions(folder):
    data=[]
    for path in sorted(Path(folder).glob("*.csv")):
        g=pd.read_csv(path)
        missing=[k for k in COLUMNS if k not in g.columns]
        if missing:raise ValueError(f"{path}: missing columns: {missing}")
        g["session"]=path.stem  # session IDs from file name; never mix days
        for k in ["at_ms","temperatureC","humidityPct","pressureHpa",
                  "windRpm","rainTipsInterval","aiLevelCm"]:
            g[k]=pd.to_numeric(g[k],errors="coerce")
        g.loc[~g.aiValid.map(flag),"aiLevelCm"]=np.nan
        g=g.dropna(subset=["at_ms"]).sort_values("at_ms").drop_duplicates("at_ms")
        if len(g)>10:data.append(g.reset_index(drop=True))
    return data

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--data",default="data",help="Directory of real recording sessions")
    ap.add_argument("--output",default="../backend/models/node1-rf.json")
    ap.add_argument("--seed",type=int,default=42)
    args=ap.parse_args()
    groups=load_sessions(args.data)
    if len(groups)<4:
        raise SystemExit("Need at least 4 independent recording sessions (CSV files). No model generated.")
    x,y,session={},{},{}
    for name in HORIZONS_MIN:x[name]=[];y[name]=[];session[name]=[]
    for g in groups:
        for i in range(len(g)):
            features=build_features(g,i)
            if features is None:continue
            for name in HORIZONS_MIN:
                label=target(g,i,name)
                if label is None:continue
                if name.startswith("rain") and (
                    features[1]==SENTINEL or features[2]==SENTINEL):continue
                if name=="flood3" and features[5]==SENTINEL:continue
                x[name].append(features)
                y[name].append(label)
                session[name].append(g.session.iloc[0])
    models, metrics={},{}
    for name in HORIZONS_MIN:
        target_y=np.asarray(y[name],dtype=int)
        target_x=np.asarray(x[name],dtype=np.float32)
        target_groups=np.asarray(session[name])
        if len(target_y)<150 or len(np.unique(target_groups))<4 or min(
            np.bincount(target_y,minlength=2))<30:
            print(f"[SKIP] {name}: insufficient labeled examples or class balance.")
            continue
        split=GroupShuffleSplit(n_splits=15,test_size=0.25,random_state=args.seed)
        selected=None
        for ti,vi in split.split(target_x,target_y,groups=target_groups):
            if len(set(target_y[ti]))==2 and len(set(target_y[vi]))==2:
                selected=(ti,vi);break
        if selected is None:
            print(f"[SKIP] {name}: independent test sessions lack both labels.")
            continue
        ti,vi=selected
        if min(np.bincount(target_y[ti],minlength=2))<20:
            print(f"[SKIP] {name}: training positives/negatives too few.")
            continue
        clf=RandomForestClassifier(n_estimators=80,max_depth=10,
            min_samples_leaf=6,class_weight="balanced_subsample",
            random_state=args.seed,n_jobs=-1)
        clf.fit(target_x[ti],target_y[ti])
        probs=clf.predict_proba(target_x[vi])[:,list(clf.classes_).index(1)]
        pred=(probs>=0.5).astype(int)
        metrics[name]={
            "trainRows":int(len(ti)),"testRows":int(len(vi)),
            "trainSessions":len(set(target_groups[ti])),
            "testSessions":len(set(target_groups[vi])),
            "accuracy":round(float(accuracy_score(target_y[vi],pred)),4),
            "balancedAccuracy":round(float(balanced_accuracy_score(target_y[vi],pred)),4),
            "precision":round(float(precision_score(target_y[vi],pred,zero_division=0)),4),
            "recall":round(float(recall_score(target_y[vi],pred,zero_division=0)),4),
            "f1":round(float(f1_score(target_y[vi],pred,zero_division=0)),4),
            "rocAuc":round(float(roc_auc_score(target_y[vi],probs)),4),
        }
        models[name]={"trees":[export_tree(est) for est in clf.estimators_],
                      "metrics":metrics[name],"positiveClass":1}
        print("[TRAINED]",name,metrics[name])
    if not models:
        raise SystemExit("Insufficient validated data. No model generated.")
    result={
        "format":"FloodGuard-RF-v1","trainedOn":"recorded-telemetry",
        "featureNames":FEATURES,"missingValue":SENTINEL,
        "simulation":{"realMinutesPerSimHour":1},
        "targets":{
            "rain1":"Rain starts within next 1 real minute if currently dry",
            "rain2":"Rain starts within next 2 real minutes if currently dry",
            "rain3":"Rain starts within next 3 real minutes if currently dry",
            "flood3":"AI water level reaches 7 cm within next 3 real minutes",
        },
        "models":models
    }
    p=Path(args.output);p.parent.mkdir(parents=True,exist_ok=True)
    p.write_text(json.dumps(result,separators=(",",":"),allow_nan=False),encoding="utf-8")
    print("Wrote",p,"with models:",", ".join(models))

if __name__=="__main__":
    main()
