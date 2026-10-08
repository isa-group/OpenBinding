
#!/usr/bin/env python3
import argparse
import os

import numpy as np
import pandas as pd
from scipy.stats import norm, gamma as gamma_dist, beta as beta_dist

DATA_DIR = "data"
os.makedirs(DATA_DIR, exist_ok=True)

BASE_N = 1000  # build 1000×1000 base each run

RHO = 0.8      # negative correlation between time & reliability
GAMMA_SHAPE = 2.0      # shape for time
GAMMA_SCALE = 1.0      # scale for time
BETA_A = 2.0      # alpha for reliability
BETA_B = 5.0      # beta for reliability
NOISE_SIGMA = 0.1      # rel noise in cost

def build_base(tmin, tmax, rmin, rmax, cmin, cmax, rng):
    Sigma = [[1, -RHO], [-RHO, 1]]
    Z = rng.multivariate_normal(mean=[0,0], cov=Sigma, size=BASE_N*BASE_N)
    U = norm.cdf(Z)  # uniform marginals, shape (BASE_N^2, 2)

    T_raw = gamma_dist(a=GAMMA_SHAPE, scale=GAMMA_SCALE).ppf(U[:,0])
    R_raw = beta_dist(a=BETA_A, b=BETA_B).ppf(U[:,1])

    T_mat = T_raw.reshape(BASE_N, BASE_N)
    R_mat = R_raw.reshape(BASE_N, BASE_N)

    t0, t1 = T_mat.min(), T_mat.max()
    T_u = (T_mat - t0) / (t1 - t0 + 1e-12)
    T_s = T_u * (tmax - tmin) + tmin

    r0, r1 = R_mat.min(), R_mat.max()
    R_u = (R_mat - r0) / (r1 - r0 + 1e-12)
    R_s = R_u * (rmax - rmin) + rmin

    C_base = T_u * (cmax - cmin) + cmin
    noise  = rng.normal(loc=1.0, scale=NOISE_SIGMA, size=(BASE_N, BASE_N))
    C_s     = np.clip(C_base * noise, cmin, cmax)

    time_rows = np.empty_like(T_s, dtype=int)
    rel_rows  = np.empty_like(R_s)
    cost_rows = np.empty_like(C_s)
    for i in range(BASE_N):
        asc = bool(rng.integers(0,2))
        row_t = np.sort(T_s[i]) if asc else np.sort(T_s[i])[::-1]
        row_r = np.sort(R_s[i]) if asc else np.sort(R_s[i])[::-1]
        order = np.argsort(T_s[i])
        if not asc:
            order = order[::-1]
        row_c = C_s[i, order]
        time_rows[i] = np.round(row_t).astype(int)
        rel_rows[i]  = np.round(row_r, 3)
        cost_rows[i] = np.round(row_c).astype(int)

    idx = [f"BaseTask_{i+1}" for i in range(BASE_N)]
    cols= [f"BaseSrv_{j+1}" for j in range(BASE_N)]
    return (
        pd.DataFrame(time_rows, index=idx, columns=cols),
        pd.DataFrame(rel_rows,  index=idx, columns=cols),
        pd.DataFrame(cost_rows, index=idx, columns=cols),
    )

def sample_submatrix(time_df, rel_df, cost_df, n_task, n_srv, rng):
    rows = rng.choice(BASE_N, size=n_task, replace=False)
    sub_t, sub_r, sub_c = [], [], []
    for i in rows:
        if n_srv <= (BASE_N+1)//2 and rng.random() < 0.5:
            offset = rng.integers(0,2)
            cand   = np.arange(offset, BASE_N, 2)
            start  = rng.integers(0, len(cand)-n_srv+1)
            cols   = cand[start:start+n_srv]
        else:
            start = rng.integers(0, BASE_N-n_srv+1)
            cols  = np.arange(start, start+n_srv)
        sub_t.append(time_df.iloc[i, cols].values.tolist())
        sub_r.append(rel_df.iloc[i, cols].values.tolist())
        sub_c.append(cost_df.iloc[i, cols].values.tolist())

    idx = [f"Task_{i+1}"   for i in range(n_task)]
    cols= [f"Server_{j+1}" for j in range(n_srv)]
    return (
        pd.DataFrame(sub_t, index=idx, columns=cols),
        pd.DataFrame(sub_r, index=idx, columns=cols),
        pd.DataFrame(sub_c, index=idx, columns=cols),
    )

def generate_capacity_demand(n_srv, n_task, cap_range, dem_range, rng):
    cap = rng.integers(cap_range[0], cap_range[1]+1, size=n_srv)
    dem = rng.integers(dem_range[0], dem_range[1]+1, size=n_task)
    cap_ser = pd.Series(cap, index=[f"Server_{j+1}" for j in range(n_srv)],
                        name="Capacity")
    dem_ser = pd.Series(dem, index=[f"Task_{i+1}" for i in range(n_task)],
                        name="Demand")
    if dem_ser.max() > cap_ser.max() or dem_ser.sum() > cap_ser.sum():
        raise ValueError("Generated capacities/demands infeasible!")
    return cap_ser, dem_ser

def write_scp(args, path, time_df, rel_df, cost_df, cap_ser, dem_ser):
    with open(path, "w") as f:
        hdr = [
            f"NAME              : {os.path.basename(path)}",
            "COMMENT           : Large size benchmark for service-composition",
            "TYPE              : SERVICE_COMPOSITION",
            f"DIM_TASKS         : {args.task}",
            f"DIM_SERVERS       : {args.server}",
            f"TIME_RANGE        : {args.tmin} {args.tmax}",
            f"RELIABILITY_RANGE : {args.rmin:.3f} {args.rmax:.3f}",
            f"COST_RANGE        : {args.cmin} {args.cmax}",
            f"DEMAND_RANGE      : {args.demmin} {args.demmax}",
            f"CAPACITY_RANGE    : {args.capmin} {args.capmax}",
            "",
        ]
        f.write("\n".join(hdr))

        def dump_table(title, df):
            f.write(f"{title}\n")
            for row in df.itertuples(index=False):
                f.write(" ".join(map(str, row)) + "\n")

        def dump_series(title, ser):
            f.write(f"{title}\n")
            for v in ser:
                f.write(f"{v}\n")

        dump_table("TIME_SECTION",        time_df)
        dump_table("RELIABILITY_SECTION", rel_df)
        dump_table("COST_SECTION",        cost_df)
        dump_series("CAPACITY_SECTION",   cap_ser)
        dump_series("DEMAND_SECTION",     dem_ser)
        f.write("EOF")

    print(f"Saved: {path}")

if __name__ == "__main__":
    p = argparse.ArgumentParser(
        description="Generate dataset for service composition problem in cloud manufacturing in .scp format."
    )
    p.add_argument("--task",   type=int,   default=5,      help="# of tasks")
    p.add_argument("--server", type=int,   default=5,      help="# of servers")
    p.add_argument("--tmin",   type=float, default=100.0,  help="min time")
    p.add_argument("--tmax",   type=float, default=3000.0, help="max time")
    p.add_argument("--rmin",   type=float, default=0.2,    help="min rel")
    p.add_argument("--rmax",   type=float, default=0.999,   help="max rel")
    p.add_argument("--cmin",   type=float, default=10.0,   help="min cost")
    p.add_argument("--cmax",   type=float, default=500.0,  help="max cost")
    p.add_argument("--capmin", type=int,   default=1000,   help="min cap")
    p.add_argument("--capmax", type=int,   default=9000,   help="max cap")
    p.add_argument("--demmin", type=int,   default=10,     help="min dem")
    p.add_argument("--demmax", type=int,   default=500,    help="max dem")
    p.add_argument("--seed",   type=int,   default=None)
    args = p.parse_args()

    rng = np.random.default_rng(args.seed)

    time_base, rel_base, cost_base = build_base(
        args.tmin, args.tmax,
        args.rmin, args.rmax,
        args.cmin, args.cmax,
        rng
    )

    time_df, rel_df, cost_df = sample_submatrix(
        time_base, rel_base, cost_base,
        args.task, args.server, rng
    )

    cap_ser, dem_ser = generate_capacity_demand(
        args.server, args.task,
        (args.capmin, args.capmax),
        (args.demmin, args.demmax),
        rng
    )

    fname = (
        f"SC-{args.task}T{args.server}S-"
        f"T{int(args.tmin)}-{int(args.tmax)}-"
        f"R{args.rmin:.2f}-{args.rmax:.2f}-"
        f"C{int(args.cmin)}-{int(args.cmax)}-"
        f"D{int(args.demmin)}-{int(args.demmax)}-"
        f"Cap{int(args.capmin)}-{int(args.capmax)}.scp"
    )
    out = os.path.join(DATA_DIR, fname)
    write_scp(args, out, time_df, rel_df, cost_df, cap_ser, dem_ser)
