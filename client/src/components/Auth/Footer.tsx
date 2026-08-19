import type { TStartupConfig } from 'librechat-data-provider';
import { useLocalize } from '~/hooks';

type FooterProps = {
  startupConfig: TStartupConfig | null | undefined;
  immersive?: boolean;
};

function Footer({ startupConfig, immersive = false }: FooterProps) {
  const localize = useLocalize();
  if (!startupConfig) {
    return null;
  }

  const privacyPolicy = startupConfig.interface?.privacyPolicy;
  const termsOfService = startupConfig.interface?.termsOfService;
  const helpAndFaqURL = startupConfig.helpAndFaqURL;
  const appTitle = startupConfig.appTitle || 'BdREN Synapse';
  const linkClassName = immersive
    ? 'text-sm text-auth-muted transition-colors duration-theme-normal hover:text-accent-primary focus:text-accent-primary'
    : 'text-sm text-accent-primary underline decoration-transparent transition-all duration-theme-normal hover:text-accent-primary-hover hover:decoration-accent-primary-hover focus:text-accent-primary-hover focus:decoration-accent-primary-hover';

  return (
    <footer
      className={`m-4 flex flex-col items-center justify-center gap-3 ${
        immersive ? 'text-auth-muted' : 'text-text-secondary'
      }`}
      role="contentinfo"
    >
      <nav className="flex flex-wrap items-center justify-center gap-x-7 gap-y-2">
        {privacyPolicy?.externalUrl && (
          <a className={linkClassName} href={privacyPolicy.externalUrl} rel="noreferrer">
            {localize('com_ui_privacy_policy')}
          </a>
        )}
        {termsOfService?.externalUrl && (
          <a className={linkClassName} href={termsOfService.externalUrl} rel="noreferrer">
            {localize('com_ui_terms_of_service')}
          </a>
        )}
        {helpAndFaqURL && (
          <a className={linkClassName} href={helpAndFaqURL} rel="noreferrer">
            {localize('com_ui_help_center')}
          </a>
        )}
      </nav>
      {immersive && (
        <p className="text-center text-sm">
          {localize('com_auth_copyright', {
            0: new Date().getFullYear(),
            1: appTitle,
          })}
        </p>
      )}
    </footer>
  );
}

export default Footer;
