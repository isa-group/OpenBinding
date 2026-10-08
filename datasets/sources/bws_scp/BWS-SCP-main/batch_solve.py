import argparse
import subprocess
import os

def run_all(data_dir, solver):
    for filename in os.listdir(data_dir):
        if filename.endswith(".scp"):
            filepath = os.path.join(data_dir, filename)
            print(f"\nSolving problem {filename}...")
            
            # Run solve.py for this file
            cmd = [
                "python", "solve.py",
                filepath,
                "--solver", solver
            ]
            
            try:
                subprocess.run(cmd, check=True)
                print(f"\nProblem {filename} solved.")
            except subprocess.CalledProcessError as e:
                print(f"Error processing {filename}: {e}")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Solve the service composition problem.")
    parser.add_argument("directory", type=str, help="Directory to the input .scp files")
    parser.add_argument("--solver", choices=['minlp', 'bisection'], required=True, help="Solver to use")
    args = parser.parse_args()

    run_all(data_dir=args.directory, solver=args.solver)
    print("\nAll files processed. Check the output directory.")