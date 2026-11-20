'use client';

/**
 * A part of the page that fails to draw says so in its own place, and the rest of the page goes on (second bug hunt,
 * 2026-11-19: a Markdown link with a "%" in it threw while the preview was drawn, and with nothing to catch it React
 * took the whole page down: the chat, the tabs, the cards waiting for the operator). It draws again when `resetKey`
 * changes (the file's text, the page's address) or at "Show it again".
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { useT } from '../lib/i18n';

type Props = { children: ReactNode; resetKey?: unknown };
type State = { error: Error | null; key: unknown };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, key: this.props.resetKey };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return Object.is(props.resetKey, state.key) ? null : { error: null, key: props.resetKey };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('A part of the page could not be drawn:', error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error) return <Caught error={this.state.error} again={() => this.setState({ error: null })} />;
    return this.props.children;
  }
}

function Caught({ error, again }: { error: Error; again: () => void }) {
  const { t } = useT();
  return (
    <div className="notice caution small part-failed" role="alert">
      <span>{t('err.part', { why: error.message || error.name })}</span>{' '}
      <button type="button" className="small" onClick={again}>
        {t('err.again')}
      </button>
    </div>
  );
}
