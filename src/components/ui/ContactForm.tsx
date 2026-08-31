import { useState } from 'react';
import { z } from 'zod';
import { reachGoal, GOALS } from '../../lib/analytics';

/**
 * Contact / lead form — React island (hydrate with client:visible).
 *
 * Submits to:
 *   • PUBLIC_CONTACT_ENDPOINT (static mode) — Formspree/Getform/Web3Forms, or
 *   • /api/contact (server mode) if the env var is empty.
 *
 * Spam defenses: minimum fill-time check only. Real validation is
 * Zod; the same shape can be reused server-side.
 */

const schema = z.object({
  name: z.string().min(2, 'Введите имя'),
  phone: z.string().min(6, 'Введите телефон'),
  message: z.string().min(10, 'Минимум 10 символов'),
});

type FieldErrors = Partial<Record<'name' | 'phone' | 'message', string>>;
type Status = 'idle' | 'sending' | 'success' | 'error';

const ENDPOINT = import.meta.env.PUBLIC_CONTACT_ENDPOINT || '/api/contact';

export default function ContactForm() {
  const [errors, setErrors] = useState<FieldErrors>({});
  const [status, setStatus] = useState<Status>('idle');
  const [startedAt] = useState(() => Date.now());

  // Takes the DOM form element (not a React event) to avoid referencing
  // React's deprecated synthetic-event type aliases. The event is inferred
  // by the inline onSubmit handler below.
  async function handleSubmit(form: HTMLFormElement) {
    const fd = new FormData(form);

    const payload = {
      name: String(fd.get('name') ?? ''),
      phone: String(fd.get('phone') ?? ''),
      message: String(fd.get('message') ?? ''),
    };

    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      const fieldErrors: FieldErrors = {};
      for (const issue of parsed.error.issues) {
        fieldErrors[issue.path[0] as keyof FieldErrors] = issue.message;
      }
      setErrors(fieldErrors);
      return;
    }
    setErrors({});
    setStatus('sending');

    let attribution: Record<string, string> = {};
    try {
      attribution = JSON.parse(sessionStorage.getItem('attribution') ?? '{}');
    } catch {
      /* ignore */
    }

    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ ...parsed.data, ...attribution, elapsed: Date.now() - startedAt }),
      });
      if (!res.ok) throw new Error('bad status');
      setStatus('success');
      reachGoal(GOALS.LEAD_SUBMIT);
      form.reset();
    } catch {
      setStatus('error');
    }
  }

  if (status === 'success') {
    return (
      <div className="card p-8 text-center">
        <p className="text-xl font-semibold">Спасибо! Заявка отправлена.</p>
        <p className="mt-2 text-muted">Мы свяжемся с вами в ближайшее время.</p>
      </div>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void handleSubmit(e.currentTarget);
      }}
      noValidate
      className="space-y-4"
    >

      <Field label="Имя" name="name" error={errors.name}>
        <input name="name" type="text" autoComplete="name" className={inputCls(errors.name)} />
      </Field>

      <Field label="Телефон" name="phone" error={errors.phone}>
        <input name="phone" type="tel" autoComplete="tel" className={inputCls(errors.phone)} />
      </Field>

      <Field label="Сообщение" name="message" error={errors.message}>
        <textarea name="message" rows={4} className={inputCls(errors.message)} />
      </Field>

      <button type="submit" disabled={status === 'sending'} className="btn btn-primary w-full py-3.5 disabled:opacity-60">
        {status === 'sending' ? 'Отправка…' : 'Отправить заявку'}
      </button>

      {status === 'error' && (
        <p className="text-center text-sm text-danger">
          Не удалось отправить. Попробуйте позже или позвоните нам.
        </p>
      )}
      <p className="text-center text-xs text-muted">
        Нажимая кнопку, вы соглашаетесь с{' '}
        <a href="/privacy-policy/" className="underline">политикой конфиденциальности</a> и даёте{' '}
        <a href="/soglasie-na-obrabotku-dannykh/" className="underline">согласие на обработку персональных данных</a>.
      </p>
    </form>
  );
}

function Field(props: { label: string; name: string; error?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium">{props.label}</span>
      {props.children}
      {props.error && <span className="mt-1 block text-sm text-danger">{props.error}</span>}
    </label>
  );
}

function inputCls(error?: string): string {
  return `w-full rounded-md border bg-paper px-4 py-3 outline-none transition-colors focus:border-accent ${
    error ? 'border-danger' : 'border-line'
  }`;
}
