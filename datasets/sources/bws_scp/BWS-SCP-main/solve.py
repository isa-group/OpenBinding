import argparse
import json
import os

from minlp import MINLP
from milp import MILP
from bisection import Bisection
from utils import read_scp, get_records_minlp

def _sanitize(rec):
    if "assignment" in rec:
        rec["assignment"] = [list(pair) for pair in rec["assignment"]]
    return rec

CWD = os.getcwd()
OUTPUT_DIR = os.path.join(CWD, 'output')
LOG_DIR = os.path.join(CWD, 'logs')
os.makedirs(OUTPUT_DIR, exist_ok=True)
os.makedirs(LOG_DIR, exist_ok=True)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Solve the service composition problem.")
    parser.add_argument("filename", type=str, help="Path to the input .scp file")
    parser.add_argument("--solver", choices=['minlp', 'bisection'], required=True, help="Solver to use")
    args = parser.parse_args()

    scp_data = read_scp(args.filename)
    if args.solver == "minlp":
        with open(os.path.join(LOG_DIR, scp_data["meta"]["NAME"] + '_MINLP.log'), 'w') as f:
            model = MINLP(scp_data, log_file=f)
            model.build_model()
            model.solve()
            record = get_records_minlp(model)
            record["solve_time"] = model.solve_time
            print(f"P={record['P']:.6g}, "
                f"reliability={record['reliability']:.4f}, "
                f"time={record['time']:.4f}, cost={record['cost']:.4f}, "
                f"objective={model.objective_value:.4f}, "
                f"assignment={record['assignment']}, "
                f"solve_time={record['solve_time']:.4f} (s)", file=f)
    else:
        bisectin = Bisection(scp_data)
        record = bisectin.run()
          
    results = {
        'record': record
    }
    if args.solver == "bisection":
        results['history'] = bisectin.history

    results["record"] = _sanitize(results["record"])
    if "history" in results:
        results["history"] = [_sanitize(r) for r in results["history"]]

    os.makedirs(os.path.join(OUTPUT_DIR, args.solver), exist_ok=True)
    base = os.path.splitext(os.path.basename(args.filename))[0]
    result_dir = os.path.join(OUTPUT_DIR, args.solver, f"{base}_{args.solver}_results.json")
    with open(result_dir, "w") as f:
        json.dump(results, f, indent=4)
    print(f"Saved results to {result_dir}")
