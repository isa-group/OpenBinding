import { config } from '../config';

export interface Engine {
  id: string;
  capabilities: any;
  active?: boolean;
}

export interface ValidationViolation {
  code: string;
  message: string;
  path?: string;
  constraint_id?: string;
  details?: any;
  stage?: number;
}

export interface Warning {
  code: string;
  message: string;
  details?: any;
}

export interface ValidationError {
  error?: string;
  violations?: ValidationViolation[];
  warnings?: Warning[];
}

export interface JobStatus {
  job_id: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  result?: any;
  error?: string;
}

export interface SolveRequest {
  engine_id: string;
  instance: any;
  options?: any;
  verbose?: boolean;
}

export interface AnalyzeRequest {
  engine_id: string;
  instance: any;
  options?: any;
  verbose?: boolean;
}

class ApiClient {
  private baseUrl: string;

  constructor(baseUrl: string = config.apiBaseUrl) {
    this.baseUrl = baseUrl;
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    
    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    // Handle validation errors (422) specially
    if (response.status === 422) {
      const errorData = await response.json();
      // Return the error data as-is so the caller can handle violations
      return errorData as T;
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return response.json();
  }

  async getEngines(): Promise<Engine[]> {
    return this.request<Engine[]>('/v1/engines');
  }

  async getGeneralSchema(): Promise<any> {
    return this.request<any>('/v1/schemas/general');
  }

  async getEngineSchema(engineId: string): Promise<any> {
    return this.request<any>(`/v1/schemas/${engineId}`);
  }

  async solve(request: SolveRequest): Promise<JobStatus> {
    return this.request<JobStatus>('/v1/solve', {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }

  async analyze(request: AnalyzeRequest): Promise<any> {
    return this.request<any>('/v1/analyze', {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }

  async getJobStatus(jobId: string): Promise<JobStatus> {
    return this.request<JobStatus>(`/v1/jobs/${jobId}`);
  }

  async pollJob(
    jobId: string,
    onUpdate?: (status: JobStatus) => void,
    interval: number = 1000
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const poll = async () => {
        try {
          const status = await this.getJobStatus(jobId);
          
          if (onUpdate) {
            onUpdate(status);
          }

          if (status.status === 'completed') {
            resolve(status.result);
          } else if (status.status === 'failed') {
            reject(new Error(status.error || 'Job failed'));
          } else {
            setTimeout(poll, interval);
          }
        } catch (error) {
          reject(error);
        }
      };

      poll();
    });
  }
}

export const apiClient = new ApiClient();
