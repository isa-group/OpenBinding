# -*- coding: utf-8 -*-

import numpy as np
import random
from datetime import datetime

start_time = datetime.now()

# Initialize parameters
n = m = None
time = []
cost = []
reliability = []
capacity = []
demand = []
current_section = None

# Read the file
with open("path to .scp file", "r") as file:
    for line in file:
        line = line.strip()

        if line.startswith("DIM_TASKS"):
            n = int(line.split(":")[-1].strip())
        elif line.startswith("DIM_SERVERS"):
            m = int(line.split(":")[-1].strip())
        elif line == "TIME_SECTION":
            current_section = "time"
            continue
        elif line == "COST_SECTION":
            current_section = "cost"
            continue
        elif line == "RELIABILITY_SECTION":
            current_section = "reliability"
            continue
        elif line == "CAPACITY_SECTION":
            current_section = "capacity"
            continue
        elif line == "DEMAND_SECTION":
            current_section = "demand"
            continue
        elif "_SECTION" in line:
            current_section = None
            continue

        # Fill appropriate matrix/vector
        if current_section == "time":
            time.append(list(map(float, line.split())))
        elif current_section == "cost":
            cost.append(list(map(float, line.split())))
        elif current_section == "reliability":
            reliability.append(list(map(float, line.split())))
        elif current_section == "capacity":
            try:
                capacity.extend(map(int, line.split()))
            except:
                pass
        elif current_section == "demand":
            try:
                demand.extend(map(int, line.split()))
            except:
                pass

# Convert to NumPy arrays
time = np.array(time)
cost = np.array(cost)
reliability = np.array(reliability)
capacity = np.array(capacity)
demand = np.array(demand)

# You now have:
# - n (number of tasks)
# - m (number of services)
# - time, cost, reliability (n x m matrices)
# - capacity, demand (vectors)

I = range(n)  #set of services
J = range(m)  #set of service providers

#print(time, cost,reliability,capacity, demand, n,m)


#W1 = 1 / cost.max(axis=1).sum()
W1 = 1 / (cost.max(axis=1).sum() - cost.min(axis=1).sum())
W2 = 1 / (time.max(axis=1).sum() - time.min(axis=1).sum())
W3 = (1 / (reliability.max(axis=1).prod() - reliability.min(axis=1).prod()))

print(W1,W2,W3)


# Generate initial random feasible solution
A = [0] * n   #allocation matrix
Cap = [0] * m  #occupied capacity of j
for i in I:
    aa = 0
    for j in J:
        if aa == 0 and demand[i] + Cap[j] <= capacity[j]:
            A[i] = j
            Cap[j] = Cap[j] + demand[i]
            aa = aa + 1
 
#constructing X_ij matrix:
def Xij_matrix(A): 
    Xij =  np.ones((n,m))
    for i in I:
        for j in J:
            Xij[i][j] = 1/reliability[i][j]
    for i in I:
        Xij[i][A[i]] = 1    
    return Xij    
               
print('Initial solution: ')
print(A)
print(Cap)

#Objective function definition
def objective_function(A):
    #Xij = Xij_matrix(A)
    total_cost = 0
    for i in I:
        total_cost = total_cost + cost[i][A[i]]
    total_time = 0
    for i in I:
        total_time = total_time + time[i][A[i]]  
    total_reliability = 1
    for i in I:
        #for j in J:
            #total_reliability = total_reliability * reliability[i][j]*Xij[i][j]
            total_reliability = total_reliability * reliability[i][A[i]]
    objective =  W2*total_time + W1* total_cost - W3*total_reliability 
    return objective 

def objective_function_show(A):
    #Xij = Xij_matrix(A)
    total_cost = 0
    for i in I:
        total_cost = total_cost + cost[i][A[i]]
    total_time = 0
    for i in I:
        total_time = total_time + time[i][A[i]]  
    total_reliability = 1
    for i in I:
        #for j in J:
            #total_reliability = total_reliability * reliability[i][j]*Xij[i][j]
            total_reliability = total_reliability * reliability[i][A[i]]
    objective =  W2*total_time + W1* total_cost - W3*total_reliability 
    return objective,total_time, total_cost,total_reliability, W2*total_time,W1* total_cost, W3*total_reliability  

print("Initial objective value:", objective_function(A))

# Generate neighbor solution
def get_neighbor(A):
    aa = random.randint(0,n-1)
    bb = random.randint(0,n-1)
    cc = random.randint(0,n-1)
    AA = [0] * n
    for i in I:
        AA[i] = A[i]
    #1-1 swap move:
    tt = AA[aa]
    AA[aa] = AA[bb]
    AA[bb] = tt
    #1-0 mutation move:
    AA[cc] = random.randint(0,m-1)
    #print('AA: ', AA)
    for j in J:
        Cap[j] = 0
    for j in J:
        for i in I:
            if AA[i]==j:
                Cap[j] = demand[i] + Cap[j]
    Cap_violation = 0
    for j in J:
        if Cap[j]>capacity[j]:
            Cap_violation = 1
    if Cap_violation == 0:  #checking capacity feasibility
        for i in I:
            A[i] = AA[i]        
    return A

# Simulated Annealing structure
CS = [0] * n
best_solution = [0] * n
for i in I:
    CS[i] = A[i] #current solution
current_cost = objective_function(CS)
#best_solution = current_solution
best_cost = current_cost
T = 1000.0   #Maximum temperture of SA
alpha = 0.99  #Cooling rate of SA
T_min = 1e-3   #Minimum temperture of SA
Max_iteration = 50  #Number of iterations at each temperture
while T > T_min:
    for _ in range(Max_iteration):
        Nei = get_neighbor(CS)  #Local search
        #print('neighbor: ',neighbor)
        neighbor_cost = objective_function(Nei)
        current_cost = objective_function(CS)
        delta = neighbor_cost - current_cost
        if delta < 0 or random.random() < np.exp(-delta / T):
            for i in I:
                CS[i] = Nei[i]
            current_cost = objective_function(CS)
            if current_cost < best_cost:
                for i in I:
                    best_solution[i] = CS[i]
                best_cost = objective_function(CS)
                print("Best cost:", objective_function_show(best_solution))
                print("Best solution:", best_solution)
    T *= alpha
    
#print("Best solution:", best_solution)
#print("Best cost:", objective_function(best_solution))

print(best_solution)
print("Best cost:", objective_function_show(best_solution))
Cap = [0] * m  #occupied capacity of j
for j in J:
    for i in I:
        if best_solution[i] == j:
            Cap[j] = Cap[j] + demand[i]

Cap_violation = 0
for j in J:
    if Cap[j]>capacity[j]:
        Cap_violation = 1
print('violation: ', Cap_violation)        
print(Cap)
end_time = datetime.now()
elapsed = end_time - start_time
print(f"Execution time: {elapsed}")