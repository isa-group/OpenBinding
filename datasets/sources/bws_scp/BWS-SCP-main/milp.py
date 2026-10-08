from gamspy import Container, Set, Parameter, Variable, Equation, Model, Sum, Sense, Options, Alias

from typing import Dict
import numpy as np
import sys
import os

from utils import sanitize_name

CWD = os.getcwd()
LOG_PATH = os.path.join(CWD, 'logs')
if not os.path.exists(LOG_PATH):
    os.makedirs(LOG_PATH)

class MILP:
    def __init__(self, 
                 data: Dict, 
                 W3: float = None,
                 log_file = None,
                 print_log=True) -> None:
        self.size = data["size"]
        self.I, self.J = data["size"]
        self.time = data["time"].values
        if "cost" in data:
            self.cost = data["cost"].values
            self.time_dependent_cost = False
        else:
            self.alpha = data["alpha"].values
            self.beta = data["beta"].values
            self.time_dependent_cost = True
        self.rel = data["reliability"].values
        self.logrel = np.log(self.rel)
        self.demand = data["demand"].values
        self.capacity = data["capacity"].values
        self.name = sanitize_name(data["meta"]["NAME"])[:20]
        self.W3 = W3
        self.print_log = print_log
        self.log_file = log_file
        self.m = Container()
    
    def define_sets(self):
        self.i = Set(container=self.m, name="i", records=np.arange(1, self.I + 1), description="tasks")
        self.j = Set(container=self.m, name="j", records=np.arange(1, self.J + 1), description="service providers")
        if self.time_dependent_cost:
            self.ip = Alias(container=self.m, name="ip", alias_with=self.i)
    
    def define_parameters(self):
        self.T = Parameter(container=self.m, domain=[self.i,self.j], name="T", records=self.time, description="service time")
        self.LR = Parameter(container=self.m, domain=[self.i,self.j], name="LR", records=self.logrel, description="log service reliability")
        self.D = Parameter(container=self.m, domain=self.i, name="D", records=self.demand, description="service demand")
        self.Cap = Parameter(container=self.m, domain=self.j, name="Cap", records=self.capacity, description="service capacity")
        if self.time_dependent_cost:
            self.ALPHA = Parameter(container=self.m, domain=[self.j], name="ALPHA", records=self.alpha, description="time-dependent service cost")
            self.BETA = Parameter(container=self.m, domain=[self.j], name="BETA", records=self.beta, description="time-independent service cost")
        else:
            self.C = Parameter(container=self.m, domain=[self.i,self.j], name="C", records=self.cost, description="service cost")

    def define_weights(self):
        T_max = self.time.max(axis=1).sum()
        T_min = self.time.min(axis=1).sum()
        LR_max = self.logrel.max(axis=1).sum()
        LR_min = self.logrel.min(axis=1).sum()
        if self.time_dependent_cost:
            C_max = (self.alpha * self.time + self.beta).max(axis=1).sum()
            C_min = (self.alpha * self.time).min(axis=1).sum()
        else:
            C_max = self.cost.max(axis=1).sum()
            C_min = self.cost.min(axis=1).sum()

        if T_max == T_min:
            self.W1 = 1 / T_max
        else:
            self.W1 = 1 / (T_max - T_min)

        if C_max == C_min:
            self.W2 = 1 / C_max
        else:
            self.W2 = 1 / (C_max - C_min)

        if self.W3 is None:
            if LR_max == LR_min:
                self.W3 = 1 / LR_max
            else:
                self.W3 = 1 / (LR_max - LR_min)
    
    def define_variables(self):
        self.Y = Variable(container=self.m, domain=[self.i,self.j], name="Y", type="positive", description="log service allocation reliability")
        self.Y[self.i,self.j].lo = 0.0
        self.Y[self.i,self.j].up = - self.LR[self.i,self.j]
        self.Xprime = Variable(container=self.m, domain=[self.i,self.j], name="Xprime", type="binary", description="service allocation")
        if self.time_dependent_cost:
            self.Q = Variable(container=self.m, domain=[self.i,self.j,self.ip], name="Q", type="binary", description="service assignment bilinear variable")

    def define_constraints(self):
        self.assign = Equation(container=self.m, name="assign", domain=self.i, description="service assignment constraint")
        self.cover = Equation(container=self.m, name="cover", domain=self.i, description="service coverage constraint")
        self.capacity = Equation(container=self.m, name="capacity", domain=self.j, description="serviceprovider capacity constraint")
        self.link = Equation(container=self.m, name="link", domain=[self.i,self.j], description="service allocation reliability link constraint")

        self.assign[self.i] = Sum(self.j, self.Xprime[self.i,self.j]) == 1
        self.cover[self.i] = Sum(self.j, self.Cap[self.j] * self.Xprime[self.i,self.j]) >= self.D[self.i]
        self.capacity[self.j] = Sum(self.i, self.D[self.i] * self.Xprime[self.i,self.j]) <= self.Cap[self.j]
        self.link[self.i,self.j] = self.Y[self.i,self.j] == - self.LR[self.i,self.j] * (1 - self.Xprime[self.i,self.j])

        if self.time_dependent_cost:
            self.bilinear1 = Equation(container=self.m, name="bilinear1", domain=[self.i,self.j,self.ip], description="bilinear variable constraint 1")
            self.bilinear2 = Equation(container=self.m, name="bilinear2", domain=[self.i,self.j,self.ip], description="bilinear variable constraint 2")
            self.bilinear3 = Equation(container=self.m, name="bilinear3", domain=[self.i,self.j,self.ip], description="bilinear variable constraint 3")
            
            self.bilinear1[self.i,self.j,self.ip] = self.Q[self.i,self.j,self.ip] <= self.Xprime[self.i,self.j]
            self.bilinear2[self.i,self.j,self.ip] = self.Q[self.i,self.j,self.ip] <= self.Xprime[self.ip,self.j]
            self.bilinear3[self.i,self.j,self.ip] = self.Q[self.i,self.j,self.ip] >= self.Xprime[self.i,self.j] + self.Xprime[self.ip,self.j] - 1

    def define_objective(self):
        if self.time_dependent_cost:
            self.obj = self.W1 * Sum((self.i,self.j), self.T[self.i,self.j] * self.Xprime[self.i,self.j]) \
                 + self.W2 * (
                     Sum((self.i,self.j), self.ALPHA[self.j] * self.T[self.i,self.j] * self.Xprime[self.i,self.j]) +
                     Sum((self.i,self.j,self.ip), self.BETA[self.j] * self.Q[self.i,self.j,self.ip])
                 ) \
                 - self.W3 * Sum((self.i, self.j), self.LR[self.i,self.j] + self.Y[self.i,self.j])
        else:
            self.obj = self.W1 * Sum((self.i,self.j), self.T[self.i,self.j] * self.Xprime[self.i,self.j]) \
                    + self.W2 * Sum((self.i,self.j), self.C[self.i,self.j] * self.Xprime[self.i,self.j]) \
                    - self.W3 * Sum((self.i, self.j), self.LR[self.i,self.j] + self.Y[self.i,self.j])

    def build_model(self):
        self.define_sets()
        self.define_weights()
        self.define_parameters()
        self.define_variables()
        self.define_constraints()
        self.define_objective()
        eqs = [self.assign, self.cover, self.capacity, self.link]
        if self.time_dependent_cost:
            eqs += [self.bilinear1, self.bilinear2, self.bilinear3]
        self.CM_MILP = Model(container=self.m, name=self.name, 
                            equations=eqs, problem="MIP",
                            objective=self.obj, sense=Sense.MIN)
    
    def solve(self):
        if self.print_log:
            output = sys.stdout
        elif self.log_file:
            output = self.log_file
        else:
            output = None

        opt = Options(
                    equation_listing_limit=100, 
                    variable_listing_limit=100,
                    absolute_optimality_gap=1e-5,
                    relative_optimality_gap=1e-5, 
                    time_limit=3600,
                )
        
        self.CM_MILP.solve(output=output, options=opt)
        self.rel_gap = np.abs(
            self.CM_MILP.objective_value - self.CM_MILP.objective_estimation
            ) / max(
                self.CM_MILP.objective_value, self.CM_MILP.objective_estimation
                )

    @property
    def Xprime_val(self):
        return self.Xprime.records

    @property
    def Y_val(self):
        return self.Y.records
    
    @property
    def Q_val(self):
        if self.time_dependent_cost:
            return self.Q.records
        else:
            return None

    @property
    def objective_value(self):
        return self.CM_MILP.objective_value

    def print_lists(self):
        print(self.CM_MILP.getEquationListing())
        print(self.CM_MILP.getVariableListing())
    
    def print_equations(self):
        print(self.assign.latexRepr())
        print(self.cover.latexRepr())
        print(self.capacity.latexRepr())
        print(self.link.latexRepr())
        if self.time_dependent_cost:
            print(self.bilinear1.latexRepr())
            print(self.bilinear2.latexRepr())
            print(self.bilinear3.latexRepr())

    def print_objective(self):
        print(self.obj.latexRepr())
    
    def to_latex(self, generate_pdf=False):
        path=os.path.join(LOG_PATH, 'TeX', self.name + "_MILP.tex")
        self.CM_MILP.toLatex(path=path, generate_pdf=generate_pdf)