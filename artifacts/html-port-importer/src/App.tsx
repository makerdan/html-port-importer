import { type FormEvent, type ReactNode, useMemo, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import {
  ArrowUpRight,
  Check,
  CheckCircle2,
  CircleAlert,
  FileArchive,
  FileCode2,
  Fingerprint,
  FolderOpen,
  LockKeyhole,
  Network,
  OctagonAlert,
  RotateCcw,
  ShieldCheck,
  TerminalSquare,
  UploadCloud,
  XCircle,
} from 'lucide-react';
import {
  Route,
  Switch,
  useLocation,
  Router as WouterRouter,
} from 'wouter';

const queryClient = new QueryClient();

function Home() {
  const [bundleFile, setBundleFile] = useState<File | null>(null);
  const [manifestFile, setManifestFile] = useState<File | null>(null);
  const [manifestHash, setManifestHash] = useState('');
  const [destination, setDestination] = useState('');
  const [operation, setOperation] = useState<'import' | 'verify'>('verify');
  const [status, setStatus] = useState<'idle' | 'loading' | 'verified' | 'failed' | 'blocked'>('idle');
  const [statusMessage, setStatusMessage] = useState('Waiting for a bundle and manifest');
  const [statusDetail, setStatusDetail] = useState('Choose a verification mode, then submit an exact bundle.');

  const hashValid = /^[a-fA-F0-9]{64}$/.test(manifestHash);
  const formReady = Boolean(bundleFile && manifestFile && hashValid && destination.trim());
  const statusTone = useMemo(() => {
    if (status === 'verified') return 'verified';
    if (status === 'failed') return 'failed';
    if (status === 'blocked') return 'blocked';
    if (status === 'loading') return 'loading';
    return 'idle';
  }, [status]);

  const resetForm = () => {
    setBundleFile(null);
    setManifestFile(null);
    setManifestHash('');
    setDestination('');
    setStatus('idle');
    setStatusMessage('Waiting for a bundle and manifest');
    setStatusDetail('Choose a verification mode, then submit an exact bundle.');
  };

  const chooseFile = (kind: 'bundle' | 'manifest', file: File | undefined) => {
    if (!file) return;
    if (kind === 'bundle') setBundleFile(file);
    else setManifestFile(file);
    setStatus('idle');
    setStatusMessage('Ready to check');
    setStatusDetail('All required inputs are present once the hash and destination are supplied.');
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!bundleFile || !manifestFile || !hashValid || !destination.trim()) {
      setStatus('blocked');
      setStatusMessage('Blocked before sending');
      setStatusDetail('Add both JSON files, a 64-character hexadecimal SHA-256, and a destination path.');
      return;
    }

    setStatus('loading');
    setStatusMessage(operation === 'verify' ? 'Verifying bundle' : 'Importing bundle');
    setStatusDetail('The desk is checking the manifest and destination. Imported code is never executed.');

    const payload = new FormData();
    payload.append('bundle', bundleFile);
    payload.append('manifest', manifestFile);
    payload.append('manifestSha256', manifestHash.toLowerCase());
    payload.append('destinationPath', destination.trim());

    try {
      const response = await fetch(`/api/html-port/${operation}`, {
        method: 'POST',
        body: payload,
        credentials: 'include',
      });
      let responseBody: { message?: string; detail?: string } = {};
      try {
        responseBody = await response.json();
      } catch {
        responseBody = {};
      }
      if (response.ok) {
        setStatus('verified');
        setStatusMessage(operation === 'verify' ? 'Verified' : 'Imported and verified');
        setStatusDetail(responseBody.message ?? 'The manifest matches the trusted SHA-256 and the destination is accepted.');
      } else if (response.status === 401 || response.status === 403 || response.status === 409) {
        setStatus('blocked');
        setStatusMessage('Blocked by the transfer desk');
        setStatusDetail(responseBody.detail ?? responseBody.message ?? 'The server refused this operation. No files were written.');
      } else {
        setStatus('failed');
        setStatusMessage('Verification failed');
        setStatusDetail(responseBody.detail ?? responseBody.message ?? `The server returned ${response.status}. No files were written.`);
      }
    } catch {
      setStatus('failed');
      setStatusMessage('Transfer desk unavailable');
      setStatusDetail('The API could not be reached. Check the server connection and try again.');
    }
  };

  return (
    <div className="grain min-h-[100dvh] overflow-hidden bg-background">
      <header className="border-b border-border/80 bg-background/90">
        <div className="mx-auto flex max-w-[1240px] items-center justify-between px-5 py-5 sm:px-8">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-[4px_4px_0_hsl(var(--accent))]">
              <TerminalSquare size={21} strokeWidth={1.8} />
            </div>
            <div>
              <p className="font-mono text-[10px] font-medium uppercase tracking-[0.22em] text-muted-foreground">Developer utility / 01</p>
              <p className="text-base font-extrabold tracking-[-0.03em] text-foreground">HTML Port Importer</p>
            </div>
          </div>
          <div className="hidden items-center gap-2 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground sm:flex">
            <span className="h-2 w-2 rounded-full bg-primary" />
            Local transfer desk
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-[1240px] gap-8 px-5 py-8 sm:px-8 sm:py-12 lg:grid-cols-[250px_minmax(0,1fr)] lg:gap-16">
        <aside className="animate-rise-in flex flex-col justify-between lg:min-h-[650px]">
          <div>
            <p className="font-mono text-[11px] font-medium uppercase tracking-[0.18em] text-primary">Exact transfer</p>
            <h1 className="mt-4 max-w-[220px] text-[clamp(2.25rem,5vw,3.9rem)] font-extrabold leading-[0.95] tracking-[-0.07em] text-foreground">
              Move HTML with proof.
            </h1>
            <p className="mt-6 max-w-[235px] text-sm leading-6 text-muted-foreground">
              A careful handoff for normalized HTML bundles. Every input is visible. Nothing runs here.
            </p>
          </div>

          <div className="mt-8 space-y-3 lg:mt-0">
            <div className="flex items-start gap-3 border-t border-border pt-4">
              <Fingerprint className="mt-0.5 shrink-0 text-primary" size={17} />
              <div>
                <p className="text-xs font-bold text-foreground">Independent trust</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">The SHA-256 comes from a separate trusted channel.</p>
              </div>
            </div>
            <div className="flex items-start gap-3 border-t border-border pt-4">
              <LockKeyhole className="mt-0.5 shrink-0 text-primary" size={17} />
              <div>
                <p className="text-xs font-bold text-foreground">No execution</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">Imported HTML is treated as bytes, never as a page.</p>
              </div>
            </div>
          </div>
        </aside>

        <section className="animate-rise-in-delay">
          <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Transfer desk</p>
              <h2 className="mt-2 text-2xl font-extrabold tracking-[-0.045em] text-foreground sm:text-3xl">Prepare a port</h2>
            </div>
            <div className="flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
              <Network size={13} />
              API connected on submit
            </div>
          </div>

          <form onSubmit={handleSubmit} className="overflow-hidden rounded-2xl border border-card-border bg-card shadow-[var(--shadow-soft)]">
            <div className="border-b border-border bg-secondary/45 px-5 py-4 sm:px-7">
              <div className="flex items-start gap-3">
                <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground">
                  <ShieldCheck size={16} />
                </div>
                <div>
                  <p className="text-sm font-bold text-foreground">Source materials</p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">Select the exact files from the normalized export. JSON files stay untouched in transit.</p>
                </div>
              </div>
            </div>

            <div className="space-y-7 px-5 py-6 sm:px-7 sm:py-8">
              <div className="grid gap-4 sm:grid-cols-2">
                <FilePicker
                  id="bundle-file"
                  label="HTML bundle"
                  hint="bundle.json"
                  icon={<FileArchive size={20} />}
                  file={bundleFile}
                  onChange={(file) => chooseFile('bundle', file)}
                  accept=".json,application/json"
                />
                <FilePicker
                  id="manifest-file"
                  label="Manifest"
                  hint="manifest.json"
                  icon={<FileCode2 size={20} />}
                  file={manifestFile}
                  onChange={(file) => chooseFile('manifest', file)}
                  accept=".json,application/json"
                />
              </div>

              <div className="grid gap-6 sm:grid-cols-[1.35fr_1fr]">
                <div>
                  <label htmlFor="manifest-hash" className="flex items-center justify-between text-xs font-bold text-foreground">
                    <span>Trusted manifest SHA-256</span>
                    <span className="font-mono text-[10px] font-normal text-muted-foreground">64 hex characters</span>
                  </label>
                  <div className="relative mt-2">
                    <Fingerprint className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" size={16} />
                    <input
                      id="manifest-hash"
                      data-testid="input-manifest-hash"
                      type="text"
                      inputMode="text"
                      autoComplete="off"
                      spellCheck={false}
                      maxLength={64}
                      value={manifestHash}
                      onChange={(event) => setManifestHash(event.target.value.replace(/[^a-fA-F0-9]/g, ''))}
                      placeholder="paste trusted digest"
                      className={`hash-field focus-ring h-11 w-full rounded-lg border bg-background pl-10 pr-3 text-xs text-foreground transition-colors placeholder:text-muted-foreground/65 ${manifestHash && !hashValid ? 'border-destructive' : 'border-input'}`}
                    />
                  </div>
                  <p className={`mt-2 text-[11px] ${manifestHash && !hashValid ? 'text-destructive' : 'text-muted-foreground'}`}>
                    {manifestHash && !hashValid ? `${manifestHash.length}/64 characters — keep entering the digest.` : 'Paste this from a channel other than the bundle itself.'}
                  </p>
                </div>

                <div>
                  <label htmlFor="destination-path" className="text-xs font-bold text-foreground">Destination path</label>
                  <div className="relative mt-2">
                    <FolderOpen className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" size={16} />
                    <input
                      id="destination-path"
                      data-testid="input-destination-path"
                      type="text"
                      value={destination}
                      onChange={(event) => setDestination(event.target.value)}
                      placeholder="/var/www/site"
                      className="focus-ring h-11 w-full rounded-lg border border-input bg-background pl-10 pr-3 font-mono text-xs text-foreground transition-colors placeholder:text-muted-foreground/65"
                    />
                  </div>
                  <p className="mt-2 text-[11px] text-muted-foreground">The server-side path that will receive the port.</p>
                </div>
              </div>

              <div className="border-t border-border pt-6">
                <fieldset>
                  <legend className="text-xs font-bold text-foreground">Choose an operation</legend>
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <OperationButton
                      value="verify"
                      selected={operation === 'verify'}
                      onClick={() => setOperation('verify')}
                      icon={<ShieldCheck size={18} />}
                      title="Verify only"
                      description="Check integrity without writing files."
                    />
                    <OperationButton
                      value="import"
                      selected={operation === 'import'}
                      onClick={() => setOperation('import')}
                      icon={<UploadCloud size={18} />}
                      title="Import bundle"
                      description="Verify, then write to the destination."
                      warning
                    />
                  </div>
                </fieldset>
              </div>
            </div>

            <div className="flex flex-col gap-3 border-t border-border bg-secondary/30 px-5 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-7">
              <div className="flex items-start gap-2 text-[11px] leading-5 text-muted-foreground">
                <LockKeyhole size={14} className="mt-0.5 shrink-0 text-primary" />
                <span>This interface never executes imported code.</span>
              </div>
              <div className="flex gap-2">
                <button type="button" data-testid="button-reset-form" onClick={resetForm} className="focus-ring inline-flex h-11 items-center justify-center gap-2 rounded-lg border border-border px-4 text-xs font-bold text-muted-foreground transition-colors hover:bg-background hover:text-foreground">
                  <RotateCcw size={14} />
                  Reset
                </button>
                <button type="submit" data-testid={`button-submit-${operation}`} disabled={status === 'loading'} className="focus-ring inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-primary px-5 text-xs font-bold text-primary-foreground shadow-[3px_3px_0_hsl(var(--accent))] transition-transform hover:-translate-y-0.5 disabled:cursor-wait disabled:opacity-65 disabled:hover:translate-y-0">
                  {status === 'loading' ? <span className="h-1.5 w-8 animate-pulse-line rounded-full bg-primary-foreground/70" /> : operation === 'verify' ? <ShieldCheck size={15} /> : <ArrowUpRight size={15} />}
                  {status === 'loading' ? 'Checking…' : operation === 'verify' ? 'Verify bundle' : 'Import bundle'}
                </button>
              </div>
            </div>
          </form>

          <StatusPanel status={statusTone} message={statusMessage} detail={statusDetail} />

          <div className="mt-7 grid gap-3 text-xs text-muted-foreground sm:grid-cols-3">
            <div className="flex items-center gap-2"><Check size={14} className="text-primary" /> Hash checked independently</div>
            <div className="flex items-center gap-2"><Check size={14} className="text-primary" /> Destination made explicit</div>
            <div className="flex items-center gap-2"><Check size={14} className="text-primary" /> No execution in browser</div>
          </div>
        </section>
      </main>
      <footer className="mx-auto flex max-w-[1240px] flex-col gap-2 border-t border-border px-5 py-6 font-mono text-[10px] uppercase tracking-[0.13em] text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-8">
        <span>HTML Port Importer / Integrity over convenience</span>
        <span>Bytes in. No surprises out.</span>
      </footer>
    </div>
  );
}

function FilePicker({
  id,
  label,
  hint,
  icon,
  file,
  onChange,
  accept,
}: {
  id: string;
  label: string;
  hint: string;
  icon: ReactNode;
  file: File | null;
  onChange: (file: File | undefined) => void;
  accept: string;
}) {
  return (
    <div>
      <label htmlFor={id} className="text-xs font-bold text-foreground">{label}</label>
      <label htmlFor={id} data-testid={`dropzone-${id}`} className={`focus-ring group mt-2 flex min-h-[98px] cursor-pointer items-center gap-4 rounded-xl border border-dashed p-4 transition-colors ${file ? 'border-primary bg-primary/[0.06]' : 'border-border bg-background hover:border-primary/65 hover:bg-primary/[0.03]'}`}>
        <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${file ? 'bg-primary text-primary-foreground' : 'bg-secondary text-primary'}`}>{file ? <CheckCircle2 size={20} /> : icon}</span>
        <span className="min-w-0">
          <span className="block truncate text-xs font-bold text-foreground">{file ? file.name : `Select ${hint}`}</span>
          <span className="mt-1 block truncate font-mono text-[10px] text-muted-foreground">{file ? `${(file.size / 1024).toFixed(1)} KB · JSON selected` : 'Click to browse local files'}</span>
        </span>
        <input id={id} data-testid={`input-${id}`} type="file" accept={accept} onChange={(event) => onChange(event.target.files?.[0])} className="sr-only" />
      </label>
    </div>
  );
}

function OperationButton({
  value,
  selected,
  onClick,
  icon,
  title,
  description,
  warning,
}: {
  value: string;
  selected: boolean;
  onClick: () => void;
  icon: ReactNode;
  title: string;
  description: string;
  warning?: boolean;
}) {
  return (
    <button type="button" data-testid={`button-operation-${value}`} aria-pressed={selected} onClick={onClick} className={`focus-ring relative flex items-start gap-3 rounded-xl border p-4 text-left transition-colors ${selected ? 'border-primary bg-primary/[0.07]' : 'border-border bg-background hover:border-primary/55'}`}>
      <span className={`mt-0.5 ${selected ? 'text-primary' : 'text-muted-foreground'}`}>{icon}</span>
      <span>
        <span className="flex items-center gap-2 text-xs font-bold text-foreground">{title}{warning && <CircleAlert size={13} className="text-accent-foreground" />}</span>
        <span className="mt-1 block text-[11px] leading-5 text-muted-foreground">{description}</span>
      </span>
      <span className={`absolute right-3 top-3 h-3 w-3 rounded-full border ${selected ? 'border-primary bg-primary ring-2 ring-primary/20' : 'border-border'}`} />
    </button>
  );
}

function StatusPanel({
  status,
  message,
  detail,
}: {
  status: 'idle' | 'loading' | 'verified' | 'failed' | 'blocked';
  message: string;
  detail: string;
}) {
  const config = {
    idle: { icon: <Fingerprint size={19} />, label: 'Standby', className: 'border-border bg-secondary/35 text-muted-foreground' },
    loading: { icon: <span className="h-4 w-4 animate-pulse rounded-full bg-accent" />, label: 'In progress', className: 'border-accent/50 bg-accent/10 text-foreground' },
    verified: { icon: <CheckCircle2 size={19} />, label: 'Verified', className: 'border-primary/35 bg-primary/[0.08] text-primary' },
    failed: { icon: <XCircle size={19} />, label: 'Failed', className: 'border-destructive/30 bg-destructive/[0.07] text-destructive' },
    blocked: { icon: <OctagonAlert size={19} />, label: 'Blocked', className: 'border-accent/60 bg-accent/15 text-foreground' },
  }[status];

  return (
    <div data-testid="status-transfer" aria-live="polite" className={`mt-5 flex items-start gap-3 rounded-xl border px-4 py-4 transition-colors ${config.className}`}>
      <span className="mt-0.5 shrink-0">{config.icon}</span>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-mono text-[10px] font-medium uppercase tracking-[0.16em] opacity-75">{config.label}</p>
          <span className="h-1 w-1 rounded-full bg-current opacity-40" />
          <p className="text-sm font-bold text-foreground">{message}</p>
        </div>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">{detail}</p>
      </div>
    </div>
  );
}

function Router() {
  return (
    // Keep a shared shell (sidebar, navbar) outside the boundary so it
    // survives a page crash.
    <RoutedErrorBoundary>
      <Switch>
        <Route path="/" component={Home} />
        <Route component={NotFound} />
      </Switch>
    </RoutedErrorBoundary>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
