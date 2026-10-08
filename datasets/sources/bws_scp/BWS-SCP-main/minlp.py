from gamspy import Container, Set, Parameter, Variable, Equation, Model, Sum, Sense, Options, Product

from time import time as now
from typing import Dict
import numpy as np
import sys
import os

from utils import sanitize_name

CWD = os.getcwd()
LOG_PATH = os.path.join(CWD, 'logs')
if not os.path.exists(LOG_PATH):
    os.makedirs(LOG_PATH)

class MINLP:
    def __init__(self, 
                 data: Dict,
                 log_file = None) -> None:
        self.log_file = log_file
        self.size = data["size"]
        self.I, self.J = data["size"]
        self.time = data["time"].values
        self.cost = data["cost"].values
        self.rel = data["reliability"].values
        self.demand = data["demand"].values
        self.capacity = data["capacity"].values
        self.name = sanitize_name(data["meta"]["NAME"])[:20]
        self.m = Container()
    
    def define_sets(self):
        self.i = Set(container=self.m, name="i", records=np.arange(1, self.I + 1), description="tasks")
        self.j = Set(container=self.m, name="j", records=np.arange(1, self.J + 1), description="service providers")
    
    def define_parameters(self):
        self.T = Parameter(container=self.m, domain=[self.i,self.j], name="T", records=self.time, description="service time")
        self.C = Parameter(container=self.m, domain=[self.i,self.j], name="C", records=self.cost, description="service cost")
        self.R = Parameter(container=self.m, domain=[self.i,self.j], name="R", records=self.rel, description="service reliability")
        self.D = Parameter(container=self.m, domain=self.i, name="D", records=self.demand, description="service demand")
        self.Cap = Parameter(container=self.m, domain=self.j, name="Cap", records=self.capacity, description="service capacity")
    
    def define_weights(self):
        T_max = self.time.max(axis=1).sum()
        T_min = self.time.min(axis=1).sum()
        C_max = self.cost.max(axis=1).sum()
        C_min = self.cost.min(axis=1).sum()
        R_max = self.rel.max(axis=1).prod()
        R_min = self.rel.min(axis=1).prod()

        if T_max == T_min:
            self.W1 = 1 / T_max
        else:
            self.W1 = 1 / (T_max - T_min)

        if C_max == C_min:
            self.W2 = 1 / C_max
        else:
            self.W2 = 1 / (C_max - C_min)

        if R_max == R_min:
            self.W3 = 1 / R_max
        else:
            self.W3 = 1 / (R_max - R_min)
    
    def define_variables(self):
        self.X = Variable(container=self.m, domain=[self.i,self.j], name="X", type="positive", description="service allocation reliability")
        self.X[self.i,self.j].lo = 0.0
        self.X[self.i,self.j].up = 1 / self.R[self.i,self.j]
        self.Xprime = Variable(container=self.m, domain=[self.i,self.j], name="Xprime", type="binary", description="service allocation")

    def define_constraints(self):
        self.assign = Equation(container=self.m, name="assign", domain=self.i, description="service assignment constraint")
        self.cover = Equation(container=self.m, name="cover", domain=self.i, description="service coverage constraint")
        self.capacity = Equation(container=self.m, name="capacity", domain=self.j, description="serviceprovider capacity constraint")
        self.link = Equation(container=self.m, name="link", domain=[self.i,self.j], description="service allocation reliability link constraint")

        self.assign[self.i] = Sum(self.j, self.Xprime[self.i,self.j]) == 1
        self.cover[self.i] = Sum(self.j, self.Cap[self.j] * self.Xprime[self.i,self.j]) >= self.D[self.i]
        self.capacity[self.j] = Sum(self.i, self.D[self.i] * self.Xprime[self.i,self.j]) <= self.Cap[self.j]
        self.link[self.i,self.j] = self.X[self.i,self.j] - self.Xprime[self.i,self.j] == (1 / self.R[self.i,self.j]) * (1 - self.Xprime[self.i,self.j])

    def define_objective(self):
        self.obj = self.W1 * Sum((self.i,self.j), self.T[self.i,self.j] * self.Xprime[self.i,self.j]) \
                 + self.W2 * Sum((self.i,self.j), self.C[self.i,self.j] * self.Xprime[self.i,self.j]) \
                 - self.W3 * Product((self.i, self.j), self.R[self.i,self.j] * self.X[self.i,self.j])

    def build_model(self):
        self.define_sets()
        self.define_parameters()
        self.define_weights()
        self.define_variables()
        self.define_constraints()
        self.define_objective()
        self.CM_MINLP = Model(container=self.m, name=self.name, 
                              equations=[self.assign, self.cover, self.capacity, self.link], problem="MINLP",
                              objective=self.obj, sense=Sense.MIN)
    
    def solve(self):
        if self.log_file:
            output = self.log_file
        else:
            output = sys.stdout
        opt = Options(
                    node_limit=200000,
                    try_partial_integer_solution=False,
                    absolute_optimality_gap=1e-5,
                    relative_optimality_gap=1e-5,
                    equation_listing_limit=10, 
                    variable_listing_limit=10,
                    time_limit=3600,
                    )
        
        solver_opt = {
            "memnodes": 1000000,
        } 
        t0 = now()
        self.CM_MINLP.solve(output=output, 
                            options=opt,
                            solver='SBB',
                            solver_options=solver_opt,
                            )
        self.solve_time = now() - t0

    @property
    def Xprime_val(self):
        return self.Xprime.records

    @property
    def X_val(self):
        return self.X.records

    @property
    def objective_value(self):
        return self.CM_MINLP.objective_value

    def print_lists(self):
        print(self.CM_MINLP.getEquationListing())
        print(self.CM_MINLP.getVariableListing())
    
    def print_equations(self):
        print(self.assign.latexRepr())
        print(self.cover.latexRepr())
        print(self.capacity.latexRepr())
        print(self.link.latexRepr())
        print(self.obj.latexRepr())
    
    def to_latex(self, generate_pdf=False):
        path=os.path.join(LOG_PATH, self.name + "_MINLP.tex")
        self.model.toLatex(path=path, generate_pdf=generate_pdf)