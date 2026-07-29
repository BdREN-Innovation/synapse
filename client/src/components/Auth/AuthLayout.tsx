import { ThemeSelector } from '@librechat/client';
import { TStartupConfig } from 'librechat-data-provider';
import { ErrorMessage } from '~/components/Auth/ErrorMessage';
import { TranslationKeys, useLocalize } from '~/hooks';
import SocialLoginRender from './SocialLoginRender';
import NetworkBackground from './NetworkBackground';
import { BlinkAnimation } from './BlinkAnimation';
import { Banner } from '../Banners';
import Footer from './Footer';

function AuthLayout({
  children,
  header,
  isFetching,
  startupConfig,
  startupConfigError,
  pathname,
  error,
}: {
  children: React.ReactNode;
  header: React.ReactNode;
  isFetching: boolean;
  startupConfig: TStartupConfig | null | undefined;
  startupConfigError: unknown | null | undefined;
  pathname: string;
  error: TranslationKeys | null;
}) {
  const localize = useLocalize();

  const hasStartupConfigError = startupConfigError !== null && startupConfigError !== undefined;
  const DisplayError = () => {
    if (hasStartupConfigError) {
      return (
        <div className="mx-auto sm:max-w-sm">
          <ErrorMessage>{localize('com_auth_error_login_server')}</ErrorMessage>
        </div>
      );
    } else if (error === 'com_auth_error_invalid_reset_token') {
      return (
        <div className="mx-auto sm:max-w-sm">
          <ErrorMessage>
            {localize('com_auth_error_invalid_reset_token')}{' '}
            <a className="font-semibold text-green-600 hover:underline" href="/forgot-password">
              {localize('com_auth_click_here')}
            </a>{' '}
            {localize('com_auth_to_try_again')}
          </ErrorMessage>
        </div>
      );
    } else if (error != null && error) {
      return (
        <div className="mx-auto sm:max-w-sm">
          <ErrorMessage>{localize(error)}</ErrorMessage>
        </div>
      );
    }
    return null;
  };

  return (
    <div className="relative flex min-h-screen flex-col bg-white dark:bg-gray-900">
      <NetworkBackground />
      <div className="relative z-10">
        <Banner />
      </div>
      <div className="relative z-10">
        <DisplayError />
      </div>
      <div className="absolute bottom-0 left-0 z-10 md:m-4">
        <ThemeSelector />
      </div>

      <main className="relative z-10 flex flex-grow items-center justify-center">
        <div className="w-authPageWidth overflow-hidden rounded-2xl border border-border-light bg-white px-6 py-8 shadow-[0_24px_64px_-20px_rgba(16,12,32,0.28)] dark:bg-gray-900 dark:shadow-[0_24px_64px_-20px_rgba(0,0,0,0.7)] sm:max-w-md lg:w-full lg:max-w-3xl lg:px-10">
          <div className="flex flex-col items-center gap-6 lg:flex-row lg:items-center lg:gap-10">
            <div className="flex flex-col items-center gap-3 lg:w-2/5 lg:items-start lg:border-r lg:border-border-light lg:pr-8">
              <BlinkAnimation active={isFetching}>
                <img
                  src="assets/synapse-icon.svg"
                  className="h-14 w-14"
                  alt={localize('com_ui_logo', { 0: startupConfig?.appTitle ?? 'BdREN Synapse' })}
                  draggable={false}
                />
              </BlinkAnimation>
              <span className="text-center text-2xl font-semibold leading-tight text-text-primary lg:text-left">
                {startupConfig?.appTitle ?? 'BdREN Synapse'}
              </span>
            </div>
            <div className="w-full lg:w-3/5">
              {!hasStartupConfigError && !isFetching && header && (
                <h1
                  className="mb-4 text-center text-3xl font-semibold text-black dark:text-white lg:text-left"
                  style={{ userSelect: 'none' }}
                >
                  {header}
                </h1>
              )}
              {children}
              {!pathname.includes('2fa') &&
                (pathname.includes('login') || pathname.includes('register')) && (
                  <SocialLoginRender startupConfig={startupConfig} />
                )}
            </div>
          </div>
        </div>
      </main>
      <div className="relative z-10">
        <Footer startupConfig={startupConfig} />
      </div>
    </div>
  );
}

export default AuthLayout;
