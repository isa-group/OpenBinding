// The administration overview used to be built here, with the accounts, error diagnostics, usage dashboards,
// operations and the router on one page. It now lives in AdminOverview, and each of those has its own screen
// (or, until its screen exists, a panel inside the overview). This name stays for anything that still imports it.
export { AdminOverview as Admin } from './AdminOverview';
