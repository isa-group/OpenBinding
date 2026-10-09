import { configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminPricingDraft } from './AdminPricingDraft';
import { LUCIA } from './adminFixtures';
import { refusal, renderAdmin } from './adminTestUtils';
import { DRAFT_RELEASE, LIVE_RELEASE, PRICING_ROOM, PRICING_SOURCE, previewOf } from './pricingFixtures';

const platform = vi.hoisted(() => ({
  pricingControlRoom: vi.fn(),
  previewPricing: vi.fn(),
  validatePricing: vi.fn(),
  createPricingDraft: vi.fn(),
  forkPricing: vi.fn(),
  publishPricing: vi.fn(),
}));

vi.mock('../../api/platform', async () => ({
  ...await vi.importActual<typeof import('../../api/platform')>('../../api/platform'),
  platformApi: platform,
}));

vi.mock('pricing-renderer/react', () => ({ PricingRenderer: () => <div data-testid="renderer">Customer pricing</div> }));

configure({ asyncUtilTimeout: 5000 });

const VALID = { valid: true, version: '0.2.0-draft.1', digest: `sha256-${'c'.repeat(64)}`, plans: ['BASIC', 'ADVANCED', 'PRO'], add_ons: ['COMPUTE_PACK'], errors: [], warnings: ['The tag Analysis is unused.'] };
const step = (title: string) => screen.getByRole('region', { name: title });

/** Step 1, once the versions are known: edit a copy of the LIVE one. */
async function begin() {
  await screen.findByRole('radiogroup', { name: 'Version' });
  fireEvent.click(screen.getByRole('button', { name: 'Next: edit plans' }));
}

async function toValidation(limit = '12') {
  await begin();
  fireEvent.change(await screen.findByLabelText('Concurrent jobs for PRO'), { target: { value: limit } });
  fireEvent.click(screen.getByRole('button', { name: 'Next: validate' }));
  await screen.findByRole('heading', { name: '3 · Validate' });
}

async function validated() {
  await toValidation();
  fireEvent.click(within(step('3 · Validate')).getByRole('button', { name: 'Validate' }));
  await within(step('3 · Validate')).findByRole('list', { name: 'What the gateway read' });
}

describe('admin-pricing-draft · a new private draft, made with forms', { timeout: 30000 }, () => {
  beforeEach(() => {
    vi.clearAllMocks();
    platform.pricingControlRoom.mockResolvedValue(PRICING_ROOM);
    platform.previewPricing.mockImplementation(async (version: string) => previewOf(version));
    platform.validatePricing.mockResolvedValue(VALID);
    platform.createPricingDraft.mockResolvedValue({ release: { ...DRAFT_RELEASE, version: '0.2.0-draft.1' }, message: 'Draft created.' });
    platform.forkPricing.mockResolvedValue({ release: { ...DRAFT_RELEASE, version: '0.2.0-draft.1' }, message: 'Draft forked.' });
    platform.publishPricing.mockResolvedValue({ release: { ...LIVE_RELEASE, version: '0.2.0', is_live: false, space_state: 'NOT_DEPLOYED' }, message: 'Release published.' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts from the LIVE version, offers every version and the other ways to start', async () => {
    renderAdmin(<AdminPricingDraft />);
    expect(screen.getByRole('heading', { level: 1, name: 'New pricing draft' })).toBeInTheDocument();
    const versions = await screen.findByRole('radiogroup', { name: 'Version' });
    expect(within(versions).getAllByRole('radio')).toHaveLength(3);
    expect(within(versions).getByRole('radio', { name: '0.1.0 · LIVE' })).toBeChecked();
    expect(within(versions).getByRole('radio', { name: '0.2.0-draft.1 · draft' })).not.toBeChecked();
    const starts = screen.getByRole('radiogroup', { name: 'Start from' });
    expect(within(starts).getAllByRole('radio')).toHaveLength(3);
    expect(within(starts).getByRole('radio', { name: /^Edit a copy of a version/ })).toBeChecked();
    expect(screen.getByRole('list', { name: 'Steps' }).querySelectorAll('button:disabled')).toHaveLength(4);
    expect(screen.getByRole('navigation', { name: 'Administration' }).querySelector('[aria-current="page"]')).toHaveTextContent('Pricing');
  });

  it('shows the plans, features and limits of the chosen version as forms', async () => {
    renderAdmin(<AdminPricingDraft />);
    await begin();
    await waitFor(() => expect(platform.previewPricing).toHaveBeenCalledWith('0.1.0'));
    expect(await screen.findByRole('heading', { name: '2 · Plans, features and limits' })).toBeInTheDocument();
    expect(screen.getByLabelText('Solves for BASIC')).toHaveValue('10');
    expect(screen.getByLabelText('Concurrent jobs for PRO')).toHaveValue('8');
    expect(screen.getByLabelText('Solves for PRO')).toHaveValue('unlimited');
    expect(screen.getByRole('button', { name: 'Advanced analytics on BASIC' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Advanced analytics on PRO' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByLabelText('Storage for PRO')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show all 3 limits' }));
    expect(screen.getByLabelText('Storage for PRO')).toHaveValue('21474836480');
    expect(screen.getByDisplayValue('COMPUTE_PACK')).toBeInTheDocument();
    expect(screen.getByLabelText('COMPUTE_PACK adds solves')).toHaveValue('100');
    expect(screen.getByText('Drafts must never contain secrets')).toBeInTheDocument();
  });

  it('turns a feature on for a plan', async () => {
    renderAdmin(<AdminPricingDraft />);
    await begin();
    const toggle = await screen.findByRole('button', { name: 'Advanced analytics on BASIC' });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(toggle).toHaveTextContent('Included');
  });

  it('says what is wrong with a figure and keeps the next step shut until it is fixed', async () => {
    renderAdmin(<AdminPricingDraft />);
    await begin();
    const solves = await screen.findByLabelText('Solves for BASIC');
    fireEvent.change(solves, { target: { value: 'lots' } });
    expect(solves).toHaveAttribute('aria-invalid', 'true');
    expect(within(screen.getByRole('list', { name: 'What needs fixing' })).getByText('BASIC · Solves')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next: validate' })).toBeDisabled();
    fireEvent.change(solves, { target: { value: '20' } });
    expect(screen.getByRole('button', { name: 'Next: validate' })).toBeEnabled();
  });

  it('adds an add-on, names it, and removes the one it started with', async () => {
    renderAdmin(<AdminPricingDraft />);
    await begin();
    await screen.findByLabelText('COMPUTE_PACK adds solves');
    fireEvent.click(screen.getByRole('button', { name: 'New add-on' }));
    expect(screen.getByRole('group', { name: 'New add-on' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next: validate' })).toBeDisabled();
    const ids = screen.getAllByPlaceholderText('COMPUTE_PACK');
    expect(ids).toHaveLength(2);
    fireEvent.change(ids[1], { target: { value: 'STORAGE_PACK' } });
    fireEvent.change(screen.getByLabelText('STORAGE_PACK adds solves'), { target: { value: '50' } });
    expect(screen.getByRole('button', { name: 'Next: validate' })).toBeEnabled();
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove add-on' })[0]);
    expect(screen.getByLabelText('STORAGE_PACK adds solves')).toBeInTheDocument();
    expect(screen.queryByLabelText('COMPUTE_PACK adds solves')).not.toBeInTheDocument();
  });

  it('validates with the gateway, shows its verdict and compares the draft with LIVE', async () => {
    renderAdmin(<AdminPricingDraft />);
    await toValidation('12');
    const validation = step('3 · Validate');
    expect(within(validation).getByLabelText('Draft version')).toHaveValue('0.2.0-draft.1');
    expect(within(validation).getByRole('button', { name: 'Next: save draft' })).toBeDisabled();
    fireEvent.click(within(validation).getByRole('button', { name: 'Validate' }));

    const verdict = await within(validation).findByRole('list', { name: 'What the gateway read' });
    expect(within(verdict).getByText('Ready')).toBeInTheDocument();
    expect(within(verdict).getByText('BASIC · ADVANCED · PRO')).toBeInTheDocument();
    expect(within(validation).getByText('The tag Analysis is unused.')).toBeInTheDocument();
    expect(within(validation).getAllByText(/Pricing4TS/).length).toBeGreaterThan(0);
    const sent = platform.validatePricing.mock.calls[0][0] as string;
    expect(sent).toContain('version: 0.2.0-draft.1');
    expect(sent).toContain('concurrentJobs: { value: 12 }');
    expect(sent).toContain('storageBytes: { value: 21474836480 }');

    expect(within(validation).getByRole('heading', { name: 'Compared with LIVE 0.1.0' })).toBeInTheDocument();
    const changes = await within(validation).findByRole('group', { name: 'Changes against LIVE' });
    expect(within(changes).getByText('Concurrent jobs')).toBeInTheDocument();
    expect(within(changes).getByText('8')).toBeInTheDocument();
    expect(within(changes).getByText('12 ▲')).toBeInTheDocument();
    expect(within(validation).getByRole('button', { name: 'Next: save draft' })).toBeEnabled();

    fireEvent.click(within(validation).getByRole('button', { name: 'Show the customer preview' }));
    expect(screen.getByTestId('renderer')).toBeInTheDocument();
  });

  it('asks for another validation once anything changes', async () => {
    renderAdmin(<AdminPricingDraft />);
    await validated();
    const validation = step('3 · Validate');
    fireEvent.change(within(validation).getByLabelText('Draft version'), { target: { value: '0.2.0-draft.2' } });
    expect(within(validation).queryByRole('list', { name: 'What the gateway read' })).not.toBeInTheDocument();
    expect(within(validation).getByRole('button', { name: 'Next: save draft' })).toBeDisabled();
    fireEvent.change(within(validation).getByLabelText('Draft version'), { target: { value: 'v2' } });
    expect(within(validation).getByLabelText('Draft version')).toHaveAttribute('aria-invalid', 'true');
    expect(within(validation).getByRole('button', { name: 'Validate' })).toBeDisabled();
  });

  it('shows a document the gateway refuses (422), and does not let it be saved', async () => {
    platform.validatePricing.mockResolvedValue({ detail: [{ loc: ['body', 'yaml'], msg: 'plans.PRO.usageLimits: unknown limit' }] });
    renderAdmin(<AdminPricingDraft />);
    await toValidation();
    const validation = step('3 · Validate');
    fireEvent.click(within(validation).getByRole('button', { name: 'Validate' }));
    expect(await within(validation).findByText('plans.PRO.usageLimits: unknown limit')).toBeInTheDocument();
    expect(within(validation).getByText('Blocked', { selector: 'strong' })).toBeInTheDocument();
    expect(within(validation).getByRole('button', { name: 'Next: save draft' })).toBeDisabled();
  });

  it('shows the errors of a document that is not valid', async () => {
    platform.validatePricing.mockResolvedValue({ ...VALID, valid: false, errors: ['Plan BASIC needs a price.'], warnings: [] });
    renderAdmin(<AdminPricingDraft />);
    await toValidation();
    const validation = step('3 · Validate');
    fireEvent.click(within(validation).getByRole('button', { name: 'Validate' }));
    expect(await within(validation).findByText('Plan BASIC needs a price.')).toBeInTheDocument();
    expect(within(validation).getByRole('button', { name: 'Next: save draft' })).toBeDisabled();
  });

  it('saves the private draft with its changelog and reason, then publishes it as a release after a confirmation', async () => {
    renderAdmin(<AdminPricingDraft />);
    await validated();
    fireEvent.click(screen.getByRole('button', { name: 'Next: save draft' }));

    const save = await screen.findByRole('region', { name: '4 · Save a private draft' });
    fireEvent.change(within(save).getByLabelText('What changed (changelog)'), { target: { value: 'More jobs on PRO' } });
    expect(platform.createPricingDraft).not.toHaveBeenCalled();
    fireEvent.click(within(save).getByRole('button', { name: 'Save draft in SPHERE' }));
    expect(await within(save).findByText('0.2.0-draft.1 saved as a private draft')).toBeInTheDocument();
    expect(platform.createPricingDraft).toHaveBeenCalledWith(expect.stringContaining('version: 0.2.0-draft.1'), 'More jobs on PRO', { reason: 'new functionality' });
    expect(within(save).getByText(/Not public, not deployed, not LIVE/)).toBeInTheDocument();
    expect(within(save).queryByText(/certified/i)).not.toBeInTheDocument();
    expect(within(save).getByRole('link', { name: 'Open draft' })).toHaveAttribute('href', '/app/admin/pricing/0.2.0-draft.1');

    fireEvent.click(within(save).getByRole('button', { name: 'Next: publish' }));
    const publish = await screen.findByRole('region', { name: '5 · Publish an immutable release' });
    const button = within(publish).getByRole('button', { name: 'Publish' });
    expect(button).toBeDisabled();
    fireEvent.change(within(publish).getByLabelText('Release version'), { target: { value: '0.2.0-rc1' } });
    expect(within(publish).getByLabelText('Release version')).toHaveAttribute('aria-invalid', 'true');
    expect(button).toBeDisabled();
    fireEvent.change(within(publish).getByLabelText('Release version'), { target: { value: '0.2.0' } });
    expect(within(publish).getByText('A published release can never change or be deleted.')).toBeInTheDocument();
    fireEvent.click(within(publish).getByRole('button', { name: 'Publish 0.2.0' }));
    const dialog = screen.getByRole('dialog', { name: 'Publish 0.2.0 as an immutable release?' });
    expect(platform.publishPricing).not.toHaveBeenCalled();
    expect(within(dialog).getByText(/doesn’t make it LIVE and doesn’t certify its content/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Publish release' }));
    await waitFor(() => expect(platform.publishPricing).toHaveBeenCalledWith('0.2.0-draft.1', '0.2.0', 'More jobs on PRO', { reason: 'new functionality' }));
    expect(await within(publish).findByText('0.2.0 published')).toBeInTheDocument();
    expect(within(publish).getByRole('link', { name: 'Open release' })).toHaveAttribute('href', '/app/admin/pricing/0.2.0');
  });

  it('says why a draft was not saved: 409 for a version that exists, 422 for one refused, 403 for a key', async () => {
    renderAdmin(<AdminPricingDraft />);
    await validated();
    fireEvent.click(screen.getByRole('button', { name: 'Next: save draft' }));
    const save = await screen.findByRole('region', { name: '4 · Save a private draft' });

    platform.createPricingDraft.mockRejectedValueOnce(refusal(409, 'pricing_version_exists', 'Version 0.2.0-draft.1 already exists.'));
    fireEvent.click(within(save).getByRole('button', { name: 'Save draft in SPHERE' }));
    expect(await screen.findByText('The gateway refused the change (409 · pricing_version_exists)')).toBeInTheDocument();
    expect(screen.getByText('Version 0.2.0-draft.1 already exists.')).toBeInTheDocument();
    expect(within(save).queryByText(/saved as a private draft/)).not.toBeInTheDocument();

    platform.createPricingDraft.mockRejectedValueOnce(refusal(422, 'invalid_pricing', 'The document is not valid Pricing2Yaml.'));
    fireEvent.click(within(save).getByRole('button', { name: 'Save draft in SPHERE' }));
    expect(await screen.findByText('That isn’t valid (422 · invalid_pricing)')).toBeInTheDocument();

    platform.createPricingDraft.mockRejectedValueOnce(refusal(403, 'insufficient_api_key_permission'));
    fireEvent.click(within(save).getByRole('button', { name: 'Save draft in SPHERE' }));
    expect(await screen.findByText('This key can’t administer pricing (403)')).toBeInTheDocument();
  });

  it('lets the source be edited directly, behind an advanced switch, and read back into the forms', async () => {
    renderAdmin(<AdminPricingDraft />);
    await begin();
    await screen.findByLabelText('Solves for BASIC');
    fireEvent.click(screen.getByRole('button', { name: 'Advanced: edit the YAML source' }));
    const source = screen.getByLabelText('Pricing YAML') as HTMLTextAreaElement;
    expect(source.value).toContain('concurrentJobs: { value: 8 }');
    expect(screen.getByText('You’re editing the source')).toBeInTheDocument();
    expect(screen.getByLabelText('Solves for BASIC')).toBeDisabled();

    fireEvent.change(source, { target: { value: 'plans: [' } });
    fireEvent.click(screen.getByRole('button', { name: 'Use the forms again' }));
    expect(await screen.findByText('The source couldn’t be read back')).toBeInTheDocument();

    fireEvent.change(source, { target: { value: previewOf('0.1.0').replace('taskStarts: { value: 10 }', 'taskStarts: { value: 99 }') } });
    fireEvent.click(screen.getByRole('button', { name: 'Use the forms again' }));
    await waitFor(() => expect(screen.getByLabelText('Solves for BASIC')).toHaveValue('99'));
    expect(screen.getByLabelText('Solves for BASIC')).toBeEnabled();
  });

  it('forks a version into a private draft right away', async () => {
    renderAdmin(<AdminPricingDraft />);
    fireEvent.click(await screen.findByRole('radio', { name: /^Fork a version as it is/ }));
    const button = await screen.findByRole('button', { name: /^Fork 0\.1\.0 into/ });
    expect(button).toBeDisabled();
    fireEvent.change(screen.getByLabelText('New draft version'), { target: { value: '0.2.0-draft.1' } });
    fireEvent.change(screen.getByLabelText('What changed (changelog)'), { target: { value: 'Same, for review' } });
    fireEvent.click(screen.getByRole('button', { name: 'Fork 0.1.0 into 0.2.0-draft.1' }));
    await waitFor(() => expect(platform.forkPricing).toHaveBeenCalledWith('0.1.0', '0.2.0-draft.1', 'Same, for review'));
    expect(await screen.findByText('0.2.0-draft.1 saved as a private draft')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open draft' })).toHaveAttribute('href', '/app/admin/pricing/0.2.0-draft.1');
  });

  it('loads a Pricing2Yaml file into the forms without uploading it', async () => {
    renderAdmin(<AdminPricingDraft />);
    fireEvent.click(await screen.findByRole('radio', { name: /^Load a YAML file/ }));
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File([PRICING_SOURCE], 'pricing.yaml', { type: 'text/yaml' })] } });
    expect(await screen.findByText('Loaded pricing.yaml on this computer. Nothing has been uploaded.')).toBeInTheDocument();
    expect(screen.getByLabelText('Solves for BASIC')).toHaveValue('10');
    expect(platform.previewPricing).not.toHaveBeenCalledWith('pricing.yaml');
  });

  it('refuses a file that is not a pricing document', async () => {
    renderAdmin(<AdminPricingDraft />);
    fireEvent.click(await screen.findByRole('radio', { name: /^Load a YAML file/ }));
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['- just\n- a list'], 'list.yaml')] } });
    expect(await screen.findByText('list.yaml couldn’t be read')).toBeInTheDocument();
  });

  it('words a control room that cannot be read, and still allows a file', async () => {
    platform.pricingControlRoom.mockRejectedValue(refusal(502, 'pricing_control_plane_error', 'SPHERE answered 500.'));
    renderAdmin(<AdminPricingDraft />);
    expect(await screen.findByText('The pricing control plane returned an error (502 · pricing_control_plane_error)')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /^Load a YAML file/ })).toBeEnabled();
  });

  it('shows a person who is not an administrator nothing, and asks the gateway nothing', async () => {
    renderAdmin(<AdminPricingDraft />, { user: LUCIA });
    expect(await screen.findByText('Not available (403)')).toBeInTheDocument();
    expect(platform.pricingControlRoom).not.toHaveBeenCalled();
  });
});
