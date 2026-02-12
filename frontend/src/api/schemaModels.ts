import { apiClient } from './client';

class SchemaModelService {
  private generalModel: string | null | undefined;
  private engineModels = new Map<string, string | null>();

  async getGeneralModel(): Promise<string | null> {
    if (this.generalModel !== undefined) {
      return this.generalModel;
    }

    const model = await apiClient.getGeneralSchemaModel();
    this.generalModel = model;
    return model;
  }

  async getEngineModel(engineId: string): Promise<string | null> {
    if (this.engineModels.has(engineId)) {
      return this.engineModels.get(engineId) ?? null;
    }

    const model = await apiClient.getEngineSchemaModel(engineId);
    this.engineModels.set(engineId, model);
    return model;
  }

  clearCache(): void {
    this.generalModel = undefined;
    this.engineModels.clear();
  }
}

export const schemaModelService = new SchemaModelService();
