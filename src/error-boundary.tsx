import { Action, ActionPanel, Detail, Icon } from "@raycast/api";
import { Component, ReactNode } from "react";

type Props = { children: ReactNode };
type State = { error: Error | null };

// Catches render errors anywhere in the wrapped subtree and shows the message
// + stack to the user with a Copy action. Without this, an uncaught render
// error makes Raycast display "Connection interrupted" with no diagnostic.
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    // Forward to the worker's stderr so it shows up in `ray develop` logs.
    process.stderr.write(`[ErrorBoundary] ${error.stack ?? error.message}\n`);
    if (info.componentStack) {
      process.stderr.write(`[ErrorBoundary] componentStack:${info.componentStack}\n`);
    }
  }

  render() {
    const error = this.state.error;
    if (!error) return this.props.children;

    const message = error.message || String(error);
    const details = error.stack ?? message;
    return (
      <Detail
        navigationTitle="Something went wrong"
        markdown={`# Something went wrong\n\n\`\`\`\n${message}\n\`\`\`\n\nIf this keeps happening, copy the full error below and report it.`}
        actions={
          <ActionPanel>
            <Action.CopyToClipboard title="Copy Error Message" content={message} icon={Icon.Clipboard} />
            <Action.CopyToClipboard title="Copy Full Stack Trace" content={details} icon={Icon.Clipboard} />
          </ActionPanel>
        }
      />
    );
  }
}
