import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { ALLOCATION_TIMEOUT_QUEUE, AllocationService } from '../allocation.service';

interface RoundTimeoutJobData {
  rideId: string;
  round: number;
}

@Processor(ALLOCATION_TIMEOUT_QUEUE)
export class AllocationTimeoutProcessor extends WorkerHost {
  private readonly logger = new Logger(AllocationTimeoutProcessor.name);

  constructor(private readonly allocationService: AllocationService) {
    super();
  }

  async process(job: Job<RoundTimeoutJobData>): Promise<void> {
    const { rideId, round } = job.data;
    try {
      await this.allocationService.handleRoundTimeout(rideId, round);
    } catch (err) {
      this.logger.error(`Failed handling timeout for ride ${rideId} round ${round}`, err as Error);
      throw err;
    }
  }
}
