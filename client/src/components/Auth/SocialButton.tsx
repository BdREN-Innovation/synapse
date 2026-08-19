import type { ComponentType } from 'react';

type SocialButtonProps = {
  id: string;
  enabled: boolean | undefined;
  serverDomain: string;
  oauthPath: string;
  Icon: ComponentType;
  label: string;
  immersive?: boolean;
};

const SocialButton = ({
  id,
  enabled,
  serverDomain,
  oauthPath,
  Icon,
  label,
  immersive = false,
}: SocialButtonProps) => {
  if (!enabled) {
    return null;
  }

  return (
    <div className="mt-2 flex gap-x-2">
      <a
        aria-label={`${label}`}
        className={`flex min-h-14 w-full items-center justify-center gap-3 rounded-theme-control border px-5 py-3 transition-colors duration-theme-normal ${
          immersive
            ? 'border-auth-border/50 bg-auth-surface-alt/70 text-auth-text hover:bg-auth-surface-alt'
            : 'border-border-light bg-surface-primary text-text-primary hover:bg-surface-tertiary'
        }`}
        href={`${serverDomain}/oauth/${oauthPath}`}
        data-testid={id}
      >
        <Icon />
        <p>{label}</p>
      </a>
    </div>
  );
};

export default SocialButton;
