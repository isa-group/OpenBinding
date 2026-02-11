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

class HttpError extends Error {
  status: number;

  constructor(status: number, statusText: string) {
    super(`HTTP ${status}: ${statusText}`);
    this.status = status;
  }
}

class ApiClient {
  private baseUrl: string;

  constructor(baseUrl: string = config.apiBaseUrl) {
    this.baseUrl = baseUrl;
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {},
    timeoutMs?: number
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    const controller = new AbortController();
    const timeoutId = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : undefined;

    try {
      const response = await fetch(url, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          ...options.headers,
        },
        signal: controller.signal,
      });

      // Handle validation errors (422) specially
      if (response.status === 422) {
        const errorData = await response.json();
        // Return the error data as-is so the caller can handle violations
        return errorData as T;
      }

      if (!response.ok) {
        throw new HttpError(response.status, response.statusText);
      }

      return response.json();
    } catch (error: any) {
      if (error?.name === 'AbortError') {
        throw new Error('Request timed out');
      }
      throw error;
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }

  private async requestWithRetry<T>(
    endpoint: string,
    options: RequestInit,
    timeoutMs: number,
    retries: number
  ): Promise<T> {
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        return await this.request<T>(endpoint, options, timeoutMs);
      } catch (error) {
        const isHttpError = error instanceof HttpError;
        const shouldRetry = isHttpError
          ? [502, 503, 504].includes(error.status)
          : true;

        if (attempt >= retries || !shouldRetry) {
          throw error;
        }

        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    throw new Error('Request failed after retries');
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
    return this.requestWithRetry<JobStatus>(
      '/v1/solve',
      {
        method: 'POST',
        body: JSON.stringify(request),
      },
      900000,
      2
    );
  }

  async analyze(request: AnalyzeRequest): Promise<any> {
    return this.request<any>('/v1/analyze', {
      method: 'POST',
      body: JSON.stringify(request),
    }, 900000);
  }

  async getJobStatus(jobId: string, timeoutMs: number = 30000): Promise<JobStatus> {
    return this.request<JobStatus>(`/v1/jobs/${jobId}`, {}, timeoutMs);
  }

  async pollJob(
    jobId: string,
    onUpdate?: (status: JobStatus) => void,
    interval: number = 2000
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const poll = async () => {
        try {
          if (Date.now() - start > 7200000) {
            reject(new Error('Polling timed out'));
            return;
          }

          const status = await this.getJobStatus(jobId, 30000);
          
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
