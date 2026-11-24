/**
 * Making a health report (phase 5d): choose what goes in, make the PDF on
 * this device, look at it, then save or share it. Nothing is sent to the
 * server; the parent decides where the file goes.
 */
import { FileDown, Share2 } from 'lucide-react'
import { lazy, Suspense, useMemo, useState, type ReactNode } from 'react'
import { canShareFile, saveMadeFile } from '../download.ts'
import type { HubContext } from '../Shell.tsx'
import { Banner, Button, Dialog, Spinner, useAction } from '../ui.tsx'
import { localStamp, parseStamp } from './episodes.ts'
import { DEFAULT_VISIT, episodeReport, visitSummary, type ReportInput, type VisitOptions } from './reports.ts'

const PdfPreview = lazy(() => import('../pages/DocumentPreview.tsx').then((m) => ({ default: m.PdfPreview })))

/** "Sam-health-summary-2026-11-24.pdf" */
export const reportFileName = (...parts: string[]) =>
  `${parts
    .join('-')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')}.pdf`

function ReportDialog({ ctx, kind, title, fileName, make, onClose, children }: { ctx: HubContext; kind: 'visit' | 'handover' | 'record'; title: string; fileName: string; make: () => Uint8Array; onClose: () => void; children: ReactNode }) {
  const [bytes, setBytes] = useState<Uint8Array | null>(null)
  const [error, setError] = useState('')
  const blob = useMemo(() => (bytes ? new Blob([bytes as BlobPart], { type: 'application/pdf' }) : null), [bytes])
  const save = useAction(async (action: 'save' | 'share') => {
    if (bytes) await saveMadeFile(ctx.platform, { name: fileName, bytes }, action)
  })
  const build = () => {
    setError('')
    try {
      setBytes(make())
      // The activity log notes that a report was made (its kind only).
      void ctx.platform.api.post('/api/health/reports', { kind }).catch(() => undefined)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The report could not be made.')
    }
  }
  return (
    <Dialog open title={title} onClose={onClose}>
      <div className="stack">
        {!bytes ? (
          <>
            {children}
            <p className="muted small">The PDF is made on this device. Nothing is sent anywhere until you save or share it, and then only where you choose.</p>
            {error && <Banner kind="error">{error}</Banner>}
            <div className="row">
              <Button onClick={build}>Make the PDF</Button>
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
            </div>
          </>
        ) : (
          <>
            {save.error && <Banner kind="error">{save.error}</Banner>}
            <div className="row">
              <Button icon={<FileDown size={16} aria-hidden />} busy={save.busy} onClick={() => void save.run('save')}>
                Save
              </Button>
              {canShareFile(ctx.platform, fileName) && (
                <Button variant="secondary" icon={<Share2 size={16} aria-hidden />} busy={save.busy} onClick={() => void save.run('share')}>
                  Share
                </Button>
              )}
              <Button variant="ghost" onClick={() => setBytes(null)}>
                Change what is in it
              </Button>
            </div>
            <p className="muted small">It holds health details: share it only with the doctor or hospital that needs it.</p>
            <Suspense fallback={<Spinner label="Loading preview…" />}>{blob && <PdfPreview blob={blob} />}</Suspense>
          </>
        )}
      </div>
    </Dialog>
  )
}

const check = (label: string, on: boolean, set: (v: boolean) => void, hint?: string) => (
  <label className="check">
    <input type="checkbox" checked={on} onChange={(e) => set(e.target.checked)} />
    <span>
      {label}
      {hint && <span className="muted small"> {hint}</span>}
    </span>
  </label>
)

export function VisitSummaryDialog({ ctx, input, onClose }: { ctx: HubContext; input: ReportInput; onClose: () => void }) {
  const [opts, setOpts] = useState<VisitOptions>(DEFAULT_VISIT)
  const [history, setHistory] = useState<'none' | 'year' | 'all' | 'range'>('none')
  const set = (change: Partial<VisitOptions>) => setOpts((o) => ({ ...o, ...change }))
  const today = localStamp(input.now).slice(0, 10)
  const yearAgo = `${Number(today.slice(0, 4)) - 1}${today.slice(4)}`
  const effective: VisitOptions = {
    ...opts,
    historyFrom: history === 'none' ? '' : history === 'year' ? yearAgo : history === 'all' ? '0000-01-01' : opts.historyFrom,
    historyTo: history === 'range' ? opts.historyTo : '',
  }
  return (
    <ReportDialog
      ctx={ctx}
      kind="visit"
      title={`Visit summary · ${input.person.displayName}`}
      fileName={reportFileName(input.person.displayName, 'health-summary', today)}
      make={() => visitSummary({ ...input, now: Date.now() }, effective)}
      onClose={onClose}
    >
      <p className="small">Always in it: allergies, current medicines, ongoing conditions, blood type, care notes and doctors.</p>
      <fieldset className="radio-group">
        <legend>Also include</legend>
        {check('Medical aid', opts.medicalAid, (v) => set({ medicalAid: v }))}
        {check('ID number', opts.idNumber, (v) => set({ idNumber: v }), '(only if the doctor needs it)')}
        {check('Treatment for a current illness', opts.plans, (v) => set({ plans: v }))}
        {check('Vaccinations', opts.vaccinations, (v) => set({ vaccinations: v }))}
      </fieldset>
      <div className="field">
        <label htmlFor="visit-history">History</label>
        <select id="visit-history" className="select" value={history} onChange={(e) => setHistory(e.target.value as typeof history)}>
          <option value="none">None</option>
          <option value="year">The last 12 months</option>
          <option value="all">Everything</option>
          <option value="range">Between two dates</option>
        </select>
      </div>
      {history === 'range' && (
        <div className="row">
          <input className="qi-search" type="date" aria-label="History from" value={opts.historyFrom} onChange={(e) => set({ historyFrom: e.target.value })} />
          <input className="qi-search" type="date" aria-label="History to" value={opts.historyTo} onChange={(e) => set({ historyTo: e.target.value })} />
        </div>
      )}
    </ReportDialog>
  )
}

export function EpisodeReportDialog({ ctx, input, episodeId, full, onClose }: { ctx: HubContext; input: ReportInput; episodeId: string; full: boolean; onClose: () => void }) {
  const episode = input.records.find((r) => r.id === episodeId)?.content.fields ?? {}
  const [whole, setWhole] = useState(true)
  // The obvious place to start a handover from: the hospital admission, or a day ago.
  const [from, setFrom] = useState(() => episode.admitted || localStamp(Math.max(parseStamp(episode.started) || 0, input.now - 24 * 3_600_000)))
  const today = localStamp(input.now).slice(0, 10)
  return (
    <ReportDialog
      ctx={ctx}
      kind={full ? 'record' : 'handover'}
      title={`${full ? 'Full record' : 'Handover report'} · ${input.person.displayName}`}
      fileName={reportFileName(input.person.displayName, episode.title ?? 'episode', full ? 'record' : 'handover', today)}
      make={() => {
        const start = whole || full ? null : parseStamp(from)
        if (start !== null && Number.isNaN(start)) throw new Error('Choose when the report should start.')
        return episodeReport({ ...input, now: Date.now() }, episodeId, { from: start, full })
      }}
      onClose={onClose}
    >
      {full ? (
        <p className="small">Everything in the episode, oldest first, with the doses-given table, charts, doctors’ notes, tests, and the list of documents. For the family’s records or a specialist.</p>
      ) : (
        <>
          <p className="small">For the doctors taking over care: allergies, medicines, the illness so far, doses given, temperature and vitals charts, doctors’ notes and tests.</p>
          <fieldset className="radio-group">
            <legend>Covering</legend>
            <label className="check">
              <input type="radio" name="report-from" checked={whole} onChange={() => setWhole(true)} />
              <span>The whole episode</span>
            </label>
            <label className="check">
              <input type="radio" name="report-from" checked={!whole} onChange={() => setWhole(false)} />
              <span>From a chosen time</span>
            </label>
            {!whole && <input className="qi-search" type="datetime-local" aria-label="Report from" value={from} onChange={(e) => setFrom(e.target.value)} />}
          </fieldset>
        </>
      )}
    </ReportDialog>
  )
}
