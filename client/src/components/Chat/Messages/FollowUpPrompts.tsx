import { useState } from 'react';
import type { TMessage } from 'librechat-data-provider';
import { useLocalize, useSubmitMessage } from '~/hooks';
import { cn } from '~/utils';

type FollowUpPromptsProps = {
  message: TMessage;
  disabled?: boolean;
};

export default function FollowUpPrompts({ message, disabled = false }: FollowUpPromptsProps) {
  const localize = useLocalize();
  const { submitMessage } = useSubmitMessage();
  const [submitting, setSubmitting] = useState(false);
  const prompts = message.followUpPrompts;

  if (message.isCreatedByUser || !prompts || prompts.length !== 3 || message.error) {
    return null;
  }

  const handleClick = (text: string) => {
    if (disabled || submitting) {
      return;
    }
    setSubmitting(true);
    const submitted = submitMessage({
      text,
      parentMessageId: message.messageId,
      conversationId: message.conversationId,
    });
    if (submitted === false) {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="mt-2 flex flex-wrap gap-2"
      role="group"
      aria-label={localize('com_ui_follow_up_prompts')}
    >
      {prompts.map((prompt) => (
        <button
          key={prompt}
          type="button"
          className={cn(
            'rounded-full border border-border-medium px-3 py-1.5 text-left text-sm text-text-secondary transition-colors',
            'hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-xheavy',
          )}
          disabled={disabled || submitting}
          onClick={() => handleClick(prompt)}
        >
          {prompt}
        </button>
      ))}
    </div>
  );
}
