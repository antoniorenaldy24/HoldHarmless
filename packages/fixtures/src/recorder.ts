/**
 * Records a live call into a Fixture, while running the pipeline on it.
 *
 * The recorder sits where the pipeline would otherwise receive its input, so
 * the events in the fixture are exactly the events the live pipeline produced,
 * and nothing reaches the pipeline that the fixture does not hold.
 */

import type { AuthRequest, NetworkProfileName } from '@holdharmless/events';
import { FIXTURE_FORMAT_VERSION, type Fixture, type GroundTruth, type TimelineItem } from './format.js';
import { eventNumberer, type PipelineFactory, type Pipeline, type Scheduler } from './pipeline.js';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type TimelineInput = DistributiveOmit<TimelineItem, 'atMs'>;

export type RecorderOptions = {
  id: string;
  label: string;
  callId: string;
  networkProfile: NetworkProfileName;
  request: AuthRequest;
  pipeline: PipelineFactory;
  /** Injectable for tests; defaults to performance.now(). */
  clock?: () => number;
  schedule?: Scheduler;
};

const realScheduler: Scheduler = (fn, ms) => {
  const h = setTimeout(fn, ms);
  return () => clearTimeout(h);
};

export class FixtureRecorder {
  private readonly t0: number;
  private readonly startedAt: Date;
  private readonly clock: () => number;
  private readonly timeline: TimelineItem[] = [];
  private readonly numberer: ReturnType<typeof eventNumberer>;
  private readonly pipeline: Pipeline;
  private finished = false;

  constructor(private readonly opts: RecorderOptions) {
    this.clock = opts.clock ?? (() => performance.now());
    this.t0 = this.clock();
    this.startedAt = new Date();
    const nowMs = () => this.clock() - this.t0;
    this.numberer = eventNumberer(opts.callId, this.startedAt.getTime(), nowMs);
    const schedule = opts.schedule ?? realScheduler;
    let nextTimerId = 0;
    this.pipeline = opts.pipeline({
      nowMs,
      // Every firing is recorded before the pipeline sees it, like any input.
      schedule: (fn, ms) => {
        const id = nextTimerId++;
        return schedule(() => {
          if (this.finished) return; // the call is over; the pipeline was told at end()
          this.timeline.push({ atMs: this.clock() - this.t0, kind: 'timer', id });
          fn();
        }, ms);
      },
      emit: (body) => {
        // A timer the pipeline left armed past end() would otherwise append to
        // a fixture already handed out. Loud, because it is a pipeline bug.
        if (this.finished) throw new Error(`event ${body.t} emitted after the recording finished`);
        this.numberer.emit(body);
      },
    });
  }

  /** Record one item and hand it to the pipeline, in that order. */
  record(input: TimelineInput): void {
    if (this.finished) throw new Error('recorder already finished');
    if (input.kind === 'timer') throw new Error('timer items are recorded by the recorder itself, not passed in');
    const item = { ...input, atMs: this.clock() - this.t0 } as TimelineItem;
    this.timeline.push(item);
    this.pipeline.onItem(item);
  }

  finish(groundTruth: GroundTruth): Fixture {
    if (this.finished) throw new Error('recorder already finished');
    this.pipeline.end?.();
    this.finished = true;
    return {
      formatVersion: FIXTURE_FORMAT_VERSION,
      id: this.opts.id,
      label: this.opts.label,
      networkProfile: this.opts.networkProfile,
      recordedAt: this.startedAt.toISOString(),
      request: this.opts.request,
      groundTruth,
      timeline: this.timeline,
      events: this.numberer.events,
    };
  }
}
