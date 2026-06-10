import { Action, ActionPanel, Form, Icon, Toast, popToRoot, showToast } from "@raycast/api";
import { useEffect, useRef, useState } from "react";
import { ErrorBoundary } from "./error-boundary";
import { MatterSession } from "./matter-session";

export default function PairDeviceCommand() {
  return (
    <ErrorBoundary>
      <PairDeviceView />
    </ErrorBoundary>
  );
}

function PairDeviceView() {
  const sessionRef = useRef<MatterSession | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [codeError, setCodeError] = useState<string | undefined>();

  useEffect(() => {
    const session = new MatterSession();
    sessionRef.current = session;
    return () => {
      session.close();
      sessionRef.current = null;
    };
  }, []);

  async function handleSubmit(values: { code: string }) {
    const session = sessionRef.current;
    if (!session) return;
    const code = values.code.trim();
    if (!code) {
      setCodeError("Required");
      return;
    }
    setCodeError(undefined);
    setSubmitting(true);

    const toast = await showToast({
      style: Toast.Style.Animated,
      title: "Pairing device…",
      message: "This can take up to a minute.",
    });

    try {
      await session.ready;
      const { nodeId } = await session.pair(code);
      toast.style = Toast.Style.Success;
      toast.title = "Device paired";
      toast.message = `Node ${nodeId}`;
      await popToRoot();
    } catch (err) {
      toast.style = Toast.Style.Failure;
      toast.title = "Pairing failed";
      toast.message = (err as Error).message;
      setSubmitting(false);
    }
  }

  return (
    <Form
      isLoading={submitting}
      actions={
        <ActionPanel>
          <Action.SubmitForm icon={Icon.Plug} title="Pair Device" onSubmit={handleSubmit} />
        </ActionPanel>
      }
    >
      <Form.Description text="Put the device in commissioning mode, then enter its manual pairing code below." />
      <Form.TextField
        id="code"
        title="Pairing Code"
        placeholder="e.g. 34970112332"
        info="11-digit short code or 21-digit long code printed on the device."
        error={codeError}
        onChange={() => codeError && setCodeError(undefined)}
        autoFocus
      />
    </Form>
  );
}
