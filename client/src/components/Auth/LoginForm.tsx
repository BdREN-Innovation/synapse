import React, { useState, useEffect, useContext } from 'react';
import { useForm } from 'react-hook-form';
import { ArrowRight, LockKeyhole, Mail } from 'lucide-react';
import { Turnstile } from '@marsidev/react-turnstile';
import { ThemeContext, SecretInput, Spinner, Button, Input, isDark } from '@librechat/client';
import type { TLoginUser, TStartupConfig } from 'librechat-data-provider';
import type { TAuthContext } from '~/common';
import { useResendVerificationEmail, useGetStartupConfig } from '~/data-provider';
import { validateEmail } from '~/utils';
import { useLocalize } from '~/hooks';

type TLoginFormProps = {
  onSubmit: (data: TLoginUser) => void;
  startupConfig: TStartupConfig;
  error: Pick<TAuthContext, 'error'>['error'];
  setError: Pick<TAuthContext, 'setError'>['setError'];
};

const LoginForm: React.FC<TLoginFormProps> = ({ onSubmit, startupConfig, error, setError }) => {
  const localize = useLocalize();
  const { theme } = useContext(ThemeContext);
  const {
    register,
    getValues,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<TLoginUser>();
  const [showResendLink, setShowResendLink] = useState<boolean>(false);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);

  const { data: config } = useGetStartupConfig();
  const useUsernameLogin = config?.ldap?.username;
  const validTheme = isDark(theme) ? 'dark' : 'light';
  const requireCaptcha = Boolean(startupConfig.turnstile?.siteKey);
  const authInputClassName =
    'webkit-dark-styles h-14 w-full rounded-theme-control border border-auth-border/50 bg-auth-surface-alt/80 pl-12 pr-4 text-base text-auth-text transition-colors duration-theme-normal placeholder:text-auth-muted/70 hover:border-auth-border focus:border-accent-primary focus:outline-none focus-visible:border-accent-primary focus-visible:ring-2 focus-visible:ring-accent-primary/25';
  const authSecretInputClassName = `${authInputClassName} pr-12`;
  const authLabelClassName = 'mb-2 block text-sm font-medium text-auth-muted';
  const authSecretButtonClassName =
    'size-9 rounded-theme-control text-auth-muted hover:bg-transparent hover:text-auth-text';

  useEffect(() => {
    if (error && error.includes('422') && !showResendLink) {
      setShowResendLink(true);
    }
  }, [error, showResendLink]);

  const resendLinkMutation = useResendVerificationEmail({
    onMutate: () => {
      setError(undefined);
      setShowResendLink(false);
    },
  });

  if (!startupConfig) {
    return null;
  }

  const renderError = (fieldName: string) => {
    const errorMessage = errors[fieldName]?.message;
    return errorMessage ? (
      <span role="alert" className="mt-1 text-sm text-text-destructive">
        {String(errorMessage)}
      </span>
    ) : null;
  };

  const handleResendEmail = () => {
    const email = getValues('email');
    if (!email) {
      return setShowResendLink(false);
    }
    resendLinkMutation.mutate({ email });
  };

  return (
    <>
      {showResendLink && (
        <div className="mt-2 rounded-md border border-status-success-border bg-status-success-subtle px-3 py-2 text-sm text-text-secondary">
          {localize('com_auth_email_verification_resend_prompt')}
          <button
            type="button"
            className="ml-2 text-link hover:underline"
            onClick={handleResendEmail}
            disabled={resendLinkMutation.isLoading}
          >
            {localize('com_auth_email_resend_link')}
          </button>
        </div>
      )}
      <form
        className="mt-8"
        aria-label="Login form"
        method="POST"
        onSubmit={handleSubmit((data) => onSubmit(data))}
      >
        <div className="mb-5">
          <label htmlFor="email" className={authLabelClassName}>
            {useUsernameLogin
              ? localize('com_auth_username').replace(/ \(.*$/, '')
              : localize('com_auth_email_address')}
          </label>
          <div className="relative">
            <Mail
              className="pointer-events-none absolute left-4 top-1/2 z-10 size-5 -translate-y-1/2 text-auth-muted"
              strokeWidth={1.7}
              aria-hidden="true"
            />
            <Input
              type="text"
              id="email"
              autoComplete={useUsernameLogin ? 'username' : 'email'}
              aria-label={localize('com_auth_email')}
              {...register('email', {
                required: localize('com_auth_email_required'),
                maxLength: { value: 120, message: localize('com_auth_email_max_length') },
                validate: useUsernameLogin
                  ? undefined
                  : (value) => validateEmail(value, localize('com_auth_email_pattern')),
              })}
              aria-invalid={!!errors.email}
              className={authInputClassName}
              placeholder={localize('com_auth_email')}
            />
          </div>
          {renderError('email')}
        </div>
        <div className="mb-2">
          <label htmlFor="password" className={authLabelClassName}>
            {localize('com_auth_password')}
          </label>
          <div className="relative">
            <LockKeyhole
              className="pointer-events-none absolute left-4 top-1/2 z-10 size-5 -translate-y-1/2 text-auth-muted"
              strokeWidth={1.7}
              aria-hidden="true"
            />
            <SecretInput
              id="password"
              autoComplete="current-password"
              aria-label={localize('com_auth_password')}
              {...register('password', {
                required: localize('com_auth_password_required'),
                minLength: {
                  value: startupConfig?.minPasswordLength || 8,
                  message: localize('com_auth_password_min_length'),
                },
                maxLength: { value: 128, message: localize('com_auth_password_max_length') },
              })}
              aria-invalid={!!errors.password}
              className={authSecretInputClassName}
              placeholder={localize('com_auth_password')}
              controlsClassName="right-2"
              buttonClassName={authSecretButtonClassName}
            />
          </div>
          {renderError('password')}
        </div>
        {startupConfig.passwordResetEnabled && (
          <a
            href="/forgot-password"
            className="inline-flex p-1 text-sm font-medium text-accent-primary underline decoration-transparent transition-all duration-200 hover:text-accent-primary-hover hover:decoration-accent-primary-hover focus:text-accent-primary-hover focus:decoration-accent-primary-hover"
          >
            {localize('com_auth_password_forgot')}
          </a>
        )}

        {requireCaptcha && (
          <div className="my-4 flex justify-center">
            <Turnstile
              siteKey={startupConfig.turnstile!.siteKey}
              options={{
                ...startupConfig.turnstile!.options,
                theme: validTheme,
              }}
              onSuccess={setTurnstileToken}
              onError={() => setTurnstileToken(null)}
              onExpire={() => setTurnstileToken(null)}
            />
          </div>
        )}

        <div className="mt-6">
          <Button
            aria-label={localize('com_auth_continue')}
            data-testid="login-button"
            type="submit"
            disabled={(requireCaptcha && !turnstileToken) || isSubmitting}
            variant="submit"
            className="group relative h-14 w-full rounded-theme-control text-base"
          >
            {isSubmitting ? (
              <Spinner />
            ) : (
              <>
                <span>{localize('com_auth_continue')}</span>
                <ArrowRight
                  className="absolute right-4 size-5 transition-transform duration-theme-normal group-hover:translate-x-0.5"
                  aria-hidden="true"
                />
              </>
            )}
          </Button>
        </div>
      </form>
    </>
  );
};

export default LoginForm;
