import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InstanceGeneratorModal } from './InstanceGeneratorModal';
import { apiClient } from '../../api/client';

describe('InstanceGeneratorModal', () => {
  const mockLoadGenerated = vi.fn();
  const mockClose = vi.fn();

  beforeEach(() => {
    vi.restoreAllMocks();
    mockLoadGenerated.mockClear();
    mockClose.mockClear();
  });

  it('renders synthesis form by default and submits parameters', async () => {
    vi.spyOn(apiClient, 'generateBimInstance').mockResolvedValue({
      name: 'test_inst',
      package_digest: 'pkg-123',
      instance_digest: 'inst-123',
      compilation_digest: 'comp-123',
      target_engines: ['evolutionary-heuristics'],
      workload_features: { S: 10.0, D_constr: 1.0 },
      files: {
        'instance.json': { apiVersion: 'bim/v1', kind: 'Instance' },
        'application.json': { apiVersion: 'qos-binding/v1' },
      },
    });

    render(
      <InstanceGeneratorModal
        isOpen={true}
        onClose={mockClose}
        onLoadGeneratedFiles={mockLoadGenerated}
      />
    );

    expect(screen.getByText('QACO Instance Generator & Legacy Converter')).toBeInTheDocument();
    expect(screen.getByText('Synthesize Instance')).toBeInTheDocument();

    const generateBtn = screen.getByRole('button', { name: /Generate & Load into Workspace/i });
    fireEvent.click(generateBtn);

    await waitFor(() => {
      expect(apiClient.generateBimInstance).toHaveBeenCalled();
      expect(mockLoadGenerated).toHaveBeenCalledWith(
        expect.objectContaining({
          'instance.json': expect.stringContaining('bim/v1'),
        }),
        'test_inst',
        expect.objectContaining({ S: 10.0 })
      );
      expect(mockClose).toHaveBeenCalled();
    });
  });

  it('switches to legacy converter tab and parses legacy problem', async () => {
    vi.spyOn(apiClient, 'convertLegacyBimProblem').mockResolvedValue({
      name: 'legacy_inst',
      package_digest: 'pkg-leg',
      instance_digest: 'inst-leg',
      compilation_digest: 'comp-leg',
      target_engines: [],
      workload_features: { S: 8.0 },
      files: {
        'instance.json': '{"apiVersion": "bim/v1"}',
      },
    });

    render(
      <InstanceGeneratorModal
        isOpen={true}
        onClose={mockClose}
        onLoadGeneratedFiles={mockLoadGenerated}
      />
    );

    // Switch to Legacy tab
    fireEvent.click(screen.getByText('Import Legacy QACO'));

    expect(screen.getByPlaceholderText(/Paste legacy QACO instance text here/i)).toBeInTheDocument();

    const textarea = screen.getByPlaceholderText(/Paste legacy QACO instance text here/i);
    fireEvent.change(textarea, { target: { value: 'TASK 1 CANDIDATES 5' } });

    const convertBtn = screen.getByRole('button', { name: /Convert to BIM v1 & Load/i });
    fireEvent.click(convertBtn);

    await waitFor(() => {
      expect(apiClient.convertLegacyBimProblem).toHaveBeenCalledWith(
        expect.objectContaining({
          raw_text: 'TASK 1 CANDIDATES 5',
        })
      );
      expect(mockLoadGenerated).toHaveBeenCalled();
      expect(mockClose).toHaveBeenCalled();
    });
  });
});
