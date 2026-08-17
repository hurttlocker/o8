import type { DependencyInstallOptions } from './dependency-install';
import type {
  DependencyImageExpectedLease,
  DependencyImagePreparedLease,
} from './dependency-image-lease-receipt';

export interface DependencyImageExactGenerationRemountAuthority {
  recipeKey: string;
  generation: string;
  workspacePath: string;
}

export interface DependencyImageOptions {
  registryRoot?: string;
  resolveVersion?: DependencyInstallOptions['resolveVersion'];
  publisherWaitMs?: number;
  publisherPollMs?: number;
  afterImageCreated?: (imagePath: string) => Promise<void>;
  afterImageValidated?: (imagePath: string) => Promise<void>;
  beforeImageRecorded?: (imagePath: string) => Promise<void>;
  afterImageRenamed?: (imagePath: string) => Promise<void>;
  afterImageVerifiedBeforeAttach?: (imagePath: string) => Promise<void>;
  afterAttachCommand?: (leaseId: string) => Promise<void>;
  afterAttach?: (leaseId: string) => Promise<void>;
  afterLeasePrepared?: (lease: DependencyImagePreparedLease) => Promise<void>;
  expectedLease?: DependencyImageExpectedLease;
  exactGenerationRemount?: DependencyImageExactGenerationRemountAuthority;
}
