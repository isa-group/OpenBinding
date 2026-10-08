import os
import numpy as np
from time import time as now
from typing import List, Dict, Any

from gamspy import ModelStatus

from utils import get_records_milp, sanitize_name
from milp import MILP

CWD = os.getcwd()
LOG_DIR = os.path.join(CWD, 'logs')
os.makedirs(LOG_DIR, exist_ok=True)

class Bisection:
    def __init__(self, data: Dict,
                 epsilon: float = 1e-4,
                 tol: float = 1e-6) -> None:
        self.data = data
        self.R = data["reliability"].values.copy()
        self.epsilon = epsilon
        self.tol = tol
        self.W3_original = 1 / (self.R.max(axis=1).prod() - self.R.min(axis=1).prod())
        self._history: List[Dict[str, Any]] = []
        self.set_lb_ub()
    
    def set_lb_ub(self):
        logrel = np.log(self.R)
        LR_max = logrel.max(axis=1).sum()
        LR_min = logrel.min(axis=1).sum()
        self.W3_low = 0.0
        if self.W3_original < 1e6:
            self.W3_high = self.W3_original.copy()
        else:
            if LR_max != LR_min:
                self.W3_high = 2 * np.abs(LR_max) / (LR_max - LR_min)
            else:
                self.W3_high = 2 * np.abs(LR_max) / LR_max


    @property
    def history(self) -> List[Dict[str, Any]]:
        return self._history
        
    def run(self):
        with open(os.path.join(LOG_DIR, self.data["meta"]["NAME"] + '_BWS.log'), "w") as f:
            k = 0
            solve_time = 0.0
            print(f"W3_low={self.W3_low:.6g}, W3_high={self.W3_high:.6g}, W3_MINLP={self.W3_original:.6g}", file=f)
            while True:
                name = f"Bisection_Iter{k}_" + self.data["meta"]["NAME"]
                wk = (self.W3_low + self.W3_high) / 2
                iter_start_time = now()

                t0 = now()
                model = MILP(self.data, W3=wk, print_log=False, log_file=f)
                model.name = sanitize_name(name)[:25]
                model.build_model()
                build_time = now() - t0
                model.solve()
                
                if model.CM_MILP.status in [ModelStatus.OptimalGlobal, ModelStatus.Integer]:

                    record = get_records_milp(model, W3=self.W3_original)
                    record["W3"] = wk
                    P_k = record["P"]

                    gap = np.abs(wk - self.W3_original * P_k) / (self.W3_original * P_k)

                    if wk <  self.W3_original * P_k:
                        # weight too small → product too large
                        self.W3_low = wk
                    else:
                        # weight too large → product too small
                        self.W3_high = wk

                    solve_time += now() - iter_start_time - build_time

                    record.update(
                        {
                            "iter": k,
                            "gap": gap,
                            "solve_time": solve_time
                        }
                    )
                    self._history.append(record)
                    print(f"[iter={k}] W3_k={wk:.6g},  P_k={P_k:.6g},  gap={gap:.2e}, MILP_gap={model.rel_gap:.2e}, "
                        f"reliability_term={record["reliability"]:.4f}, time_term={record["time"]:.4f}, cost_term={record["cost"]:.4f}, "
                        f"MINLP Objective={record["MINLP Objective"]:.4f}", file=f)
                    print(f"[iter={k}] W3_k={wk:.6g},  P_k={P_k:.6g},  gap={gap:.2e}, MILP_gap={model.rel_gap:.2e}, "
                        f"reliability_term={record["reliability"]:.4f}, time_term={record["time"]:.4f}, cost_term={record["cost"]:.4f}, "
                        f"MINLP Objective={record["MINLP Objective"]:.4f}")
                    
                    if gap < self.epsilon:
                        print("Converged!", file=f)
                        print(f"P={record['P']:.6g}, "
                                f"reliability={record['reliability']:.4f}, "
                                f"time={record['time']:.4f}, cost={record['cost']:.4f}, "
                                f"MINLP objective={record["MINLP Objective"]:.4f}, "
                                f"MILP objective={record["MILP Objective"]:.4f}, "
                                f"assignment={record['assignment']}, "
                                f"solve_time={record['solve_time']:.4f} (s)", file=f)
                        return record

                    if (self.W3_high - self.W3_low) <= self.tol * self.W3_high:
                        print("Interval small enough; stopping early.", file=f)
                        return record
                    k += 1
                else:
                    print(f"Optimal solution not found: model status:{model.CM_MILP.status}, solver status:{model.CM_MILP.solve_status}.")
                    break