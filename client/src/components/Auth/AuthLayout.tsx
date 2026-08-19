import { Briefcase, FileText, Sparkles } from 'lucide-react';
import { ThemeSelector } from '@librechat/client';
import type { ReactNode } from 'react';
import type { TStartupConfig } from 'librechat-data-provider';
import type { LucideIcon } from 'lucide-react';
import type { TranslationKeys } from '~/hooks';
import { ErrorMessage } from '~/components/Auth/ErrorMessage';
import { BlinkAnimation } from './BlinkAnimation';
import SocialLoginRender from './SocialLoginRender';
import NetworkBackground from './NetworkBackground';
import { Banner } from '../Banners';
import { useLocalize } from '~/hooks';
import Footer from './Footer';

type AuthLayoutProps = {
  children: ReactNode;
  header: ReactNode;
  isFetching: boolean;
  startupConfig: TStartupConfig | null | undefined;
  startupConfigError: unknown | null | undefined;
  pathname: string;
  error: TranslationKeys | null;
};

function AuthFeature({ Icon, label }: { Icon: LucideIcon; label: string }) {
  const [title, description] = label.split('\n');

  return (
    <div className="flex min-w-0 flex-col items-center gap-4 px-3 text-center">
      <span className="flex size-20 items-center justify-center rounded-full border border-auth-decoration/40 bg-auth-surface-alt/30">
        <Icon className="size-10 text-auth-decoration" strokeWidth={1.5} aria-hidden="true" />
      </span>
      <div className="text-sm leading-5 text-auth-text">
        <span className="block font-bold">{title}</span>
        {description ? (
          <span className="mt-1 block font-normal text-auth-muted">{description}</span>
        ) : null}
      </div>
    </div>
  );
}

function AuthLayout({
  children,
  header,
  isFetching,
  startupConfig,
  startupConfigError,
  pathname,
  error,
}: AuthLayoutProps) {
  const localize = useLocalize();
  const hasStartupConfigError = startupConfigError !== null && startupConfigError !== undefined;
  const isLoginPage = pathname.includes('login');
  const appTitle = startupConfig?.appTitle || 'BdREN Synapse';

  const DisplayError = () => {
    if (hasStartupConfigError) {
      return (
        <div className="mx-auto sm:max-w-sm">
          <ErrorMessage>{localize('com_auth_error_login_server')}</ErrorMessage>
        </div>
      );
    }
    if (error === 'com_auth_error_invalid_reset_token') {
      return (
        <div className="mx-auto sm:max-w-sm">
          <ErrorMessage>
            {localize('com_auth_error_invalid_reset_token')}{' '}
            <a
              className="font-semibold text-accent-primary hover:underline"
              href="/forgot-password"
            >
              {localize('com_auth_click_here')}
            </a>{' '}
            {localize('com_auth_to_try_again')}
          </ErrorMessage>
        </div>
      );
    }
    if (error != null && error) {
      return (
        <div className="mx-auto sm:max-w-sm">
          <ErrorMessage>{localize(error)}</ErrorMessage>
        </div>
      );
    }
    return null;
  };

  return (
    <div
      className={`relative flex min-h-screen flex-col ${
        isLoginPage ? 'bg-auth-background font-theme-ui' : 'bg-surface-primary'
      }`}
    >
      {isLoginPage ? (
        <img
          src="/assets/auth-network-background.png"
          className="pointer-events-none fixed inset-0 h-full w-full object-cover"
          alt=""
          aria-hidden="true"
          draggable={false}
        />
      ) : (
        <NetworkBackground />
      )}
      <div className="relative z-10">
        <Banner />
      </div>
      <div className="relative z-10">
        <DisplayError />
      </div>
      <div className="absolute bottom-0 left-0 z-20 md:m-4">
        <ThemeSelector />
      </div>

      <main className="relative z-10 flex flex-grow items-center justify-center px-4 py-10 sm:px-6 lg:py-14">
        {isLoginPage ? (
          <section
            className="grid w-full max-w-6xl overflow-hidden rounded-theme-surface-lg border border-auth-border/50 bg-auth-surface/90 shadow-2xl backdrop-blur-xl lg:min-h-[44rem] lg:grid-cols-[minmax(0,0.94fr)_minmax(0,1.06fr)]"
            aria-label={localize('com_auth_login_card')}
          >
            <div className="flex flex-col items-center justify-center border-b border-auth-border/40 px-6 py-9 lg:border-b-0 lg:border-r lg:px-12 lg:py-12">
              <BlinkAnimation active={isFetching}>
                <img
                  src="/assets/logo_white.svg"
                  className="h-36 w-36 lg:h-52 lg:w-52"
                  alt={localize('com_ui_logo', { 0: appTitle })}
                  draggable={false}
                />
              </BlinkAnimation>
              {/* <span className="mt-5 text-center text-3xl font-semibold leading-tight text-auth-text lg:text-5xl">
                {appTitle}
              </span>
              <span className="mt-7 h-1 w-14 rounded-theme-control-round bg-accent-primary" /> */}
              <p className="mt-8 max-w-sm text-center text-2xl leading-7 text-auth-muted lg:text-2xl">
                {localize('com_auth_brand_tagline')}
              </p>
              {/* <div className="mt-10 hidden w-full max-w-md grid-cols-3 divide-x divide-auth-border/40 lg:grid">
                <AuthFeature Icon={Sparkles} label={localize('com_auth_feature_connectivity')} />
                <AuthFeature Icon={FileText} label={localize('com_auth_feature_security')} />
                <AuthFeature Icon={Briefcase} label={localize('com_auth_feature_collaboration')} />
              </div> */}
            </div>

            <div className="flex w-full flex-col justify-center px-6 py-9 sm:px-10 lg:px-16 lg:py-12">
              {!hasStartupConfigError && !isFetching && header && (
                <>
                  <h1
                    className="text-center text-3xl font-semibold tracking-tight text-auth-text sm:text-4xl lg:text-left"
                    style={{ userSelect: 'none' }}
                  >
                    {header}
                  </h1>
                  <p className="mt-2 text-center text-base text-auth-muted lg:text-left">
                    {localize('com_auth_sign_in_continue', { 0: appTitle })}
                  </p>
                </>
              )}
              {children}
              <SocialLoginRender startupConfig={startupConfig} immersive />
            </div>
          </section>
        ) : (
          <div className="w-authPageWidth overflow-hidden rounded-2xl border border-border-light bg-surface-primary px-6 py-8 shadow-xl sm:max-w-md lg:w-full lg:max-w-3xl lg:px-10">
            <div className="flex flex-col items-center gap-6 lg:flex-row lg:items-center lg:gap-10">
              <div className="flex flex-col items-center gap-4 lg:w-2/5 lg:border-r lg:border-border-light lg:pr-8">
                <BlinkAnimation active={isFetching}>
                  <img
                    src="/assets/synapse-icon.svg"
                    className="h-24 w-24"
                    alt={localize('com_ui_logo', { 0: appTitle })}
                    draggable={false}
                  />
                </BlinkAnimation>
                <span className="text-center text-2xl font-semibold leading-tight text-text-primary">
                  {appTitle}
                </span>
              </div>
              <div className="w-full lg:w-3/5">
                {!hasStartupConfigError && !isFetching && header && (
                  <h1
                    className="mb-4 text-center text-3xl font-semibold text-text-primary lg:text-left"
                    style={{ userSelect: 'none' }}
                  >
                    {header}
                  </h1>
                )}
                {children}
                {!pathname.includes('2fa') && pathname.includes('register') && (
                  <SocialLoginRender startupConfig={startupConfig} />
                )}
              </div>
            </div>
          </div>
        )}
      </main>
      <div className="relative z-10">
        <Footer startupConfig={startupConfig} immersive={isLoginPage} />
      </div>
    </div>
  );
}

export default AuthLayout;
