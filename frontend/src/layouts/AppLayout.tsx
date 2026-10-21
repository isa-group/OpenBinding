/**
 * Layout of the authenticated workspace: AppHeader, the screen (with the PlatformOutletContext
 * as outlet context) and SiteFooter. The implementation keeps living in PlatformShell, whose
 * name and context type the existing platform pages import.
 */
export { PlatformShell as AppLayout } from '../components/PlatformShell/PlatformShell';
