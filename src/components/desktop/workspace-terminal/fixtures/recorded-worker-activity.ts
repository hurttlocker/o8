import type { MobileTranscriptToolCall } from '@/lib/mobile/types';

export interface RecordedWorkerActivity {
  tool: MobileTranscriptToolCall;
  expectedVerb: string;
  exitCode: number;
  source: 'command_execution' | 'file_change';
}

// Sanitized owned-log commands plus a native edit receipt. The edit path is
// projected as patch-tool input; no shell command or patch body is invented.
export const recordedWorkerActivity: RecordedWorkerActivity[] = [
  {
    'tool': {
      'name': 'exec_command',
      'args': {
        'command': '/bin/zsh -lc "sed -n \'1,125p\' .agents/skills/ship/SKILL.md"'
      }
    },
    'expectedVerb': 'Read',
    'exitCode': 0,
    'source': 'command_execution'
  },
  {
    'tool': {
      'name': 'exec_command',
      'args': {
        'command': '/bin/zsh -lc "sed -n \'15,70p\' src/lib/lane/archive-terminal.ts"'
      }
    },
    'expectedVerb': 'Read',
    'exitCode': 0,
    'source': 'command_execution'
  },
  {
    'tool': {
      'name': 'exec_command',
      'args': {
        'command': '/bin/zsh -lc \'cat .github/workflows/ci.yml\''
      }
    },
    'expectedVerb': 'Read',
    'exitCode': 0,
    'source': 'command_execution'
  },
  {
    'tool': {
      'name': 'exec_command',
      'args': {
        'command': '/bin/zsh -lc \'cat src/lib/lane/terminal-states.ts\''
      }
    },
    'expectedVerb': 'Read',
    'exitCode': 0,
    'source': 'command_execution'
  },
  {
    'tool': {
      'name': 'exec_command',
      'args': {
        'command': '/bin/zsh -lc \'nl -ba src/app/dashboard/types.ts\''
      }
    },
    'expectedVerb': 'Read',
    'exitCode': 0,
    'source': 'command_execution'
  },
  {
    'tool': {
      'name': 'exec_command',
      'args': {
        'command': '/bin/zsh -lc \'nl -ba src/lib/tauri/iframe-proxy.ts\''
      }
    },
    'expectedVerb': 'Read',
    'exitCode': 0,
    'source': 'command_execution'
  },
  {
    'tool': {
      'name': 'exec_command',
      'args': {
        'command': '/bin/zsh -lc "rg -n \'stop|kill|cancel\' cli/src/commands/run.ts | head -30"'
      }
    },
    'expectedVerb': 'Searched',
    'exitCode': 0,
    'source': 'command_execution'
  },
  {
    'tool': {
      'name': 'exec_command',
      'args': {
        'command': '/bin/zsh -lc "rg -n \'paths|pathspec|packet commit\' cli/src/commands/packet* | head -45"'
      }
    },
    'expectedVerb': 'Searched',
    'exitCode': 0,
    'source': 'command_execution'
  },
  {
    'tool': {
      'name': 'exec_command',
      'args': {
        'command': '/bin/zsh -lc "git grep -n \\"recentCommits\\\\|git log --oneline\\\\|Latest commit\\\\|verification\\" "\'$(git rev-list --all) -- src docs .github 2>/dev/null | head -n 200\''
      }
    },
    'expectedVerb': 'Searched',
    'exitCode': 0,
    'source': 'command_execution'
  },
  {
    'tool': {
      'name': 'exec_command',
      'args': {
        'command': '/bin/zsh -lc \'find .. -name runtime.md -o -name runtime.md\''
      }
    },
    'expectedVerb': 'Searched',
    'exitCode': 0,
    'source': 'command_execution'
  },
  {
    'tool': {
      'name': 'exec_command',
      'args': {
        'command': '/bin/zsh -lc \'find src/lib/lane -maxdepth 1 -type f | sort\''
      }
    },
    'expectedVerb': 'Searched',
    'exitCode': 0,
    'source': 'command_execution'
  },
  {
    'tool': {
      'name': 'exec_command',
      'args': {
        'command': '/bin/zsh -lc \'ls -l artifacts/worker/native-startup-sample.txt\''
      }
    },
    'expectedVerb': 'Listed',
    'exitCode': 0,
    'source': 'command_execution'
  },
  {
    'tool': {
      'name': 'exec_command',
      'args': {
        'command': '/bin/zsh -lc \'ls -la\''
      }
    },
    'expectedVerb': 'Listed',
    'exitCode': 0,
    'source': 'command_execution'
  },
  {
    'tool': {
      'name': 'exec_command',
      'args': {
        'command': '/bin/zsh -lc \'git diff --check\''
      }
    },
    'expectedVerb': 'Checked the diff',
    'exitCode': 0,
    'source': 'command_execution'
  },
  {
    'tool': {
      'name': 'exec_command',
      'args': {
        'command': '/bin/zsh -lc \'git diff main...HEAD --stat\''
      }
    },
    'expectedVerb': 'Checked the diff',
    'exitCode': 0,
    'source': 'command_execution'
  },
  {
    'tool': {
      'name': 'exec_command',
      'args': {
        'command': '/bin/zsh -lc \'git status --short\''
      }
    },
    'expectedVerb': 'Checked status',
    'exitCode': 0,
    'source': 'command_execution'
  },
  {
    'tool': {
      'name': 'exec_command',
      'args': {
        'command': '/bin/zsh -lc \'pwd; git status --short; cat /workspace/AGENTS.md\''
      }
    },
    'expectedVerb': 'Read',
    'exitCode': 0,
    'source': 'command_execution'
  },
  {
    'tool': {
      'name': 'exec_command',
      'args': {
        'command': '/bin/zsh -lc "git log -3 --format=\'%h %s\'"'
      }
    },
    'expectedVerb': 'Checked history',
    'exitCode': 0,
    'source': 'command_execution'
  },
  {
    'tool': {
      'name': 'exec_command',
      'args': {
        'command': '/bin/zsh -lc \'git log --oneline -8\''
      }
    },
    'expectedVerb': 'Checked history',
    'exitCode': 0,
    'source': 'command_execution'
  },
  {
    'tool': {
      'name': 'exec_command',
      'args': {
        'command': '/bin/zsh -lc "o8 run -- sh -c \'npx --no-install vitest run tests/finished-packet-retirement-cli-real-path.test.ts > artifacts/worker/finished-verified.log 2>&1\'"'
      }
    },
    'expectedVerb': 'Ran tests',
    'exitCode': 1,
    'source': 'command_execution'
  },
  {
    'tool': {
      'name': 'exec_command',
      'args': {
        'command': '/bin/zsh -lc "o8 run -- bash -o pipefail -c \'npx --no-install vitest run tests/close-archived-owner-real-path.test.ts 2>&1 | tee artifacts/worker/archived-owner-retry.log\'"'
      }
    },
    'expectedVerb': 'Ran tests',
    'exitCode': 130,
    'source': 'command_execution'
  },
  {
    'tool': {
      'name': 'exec_command',
      'args': {
        'command': '/bin/zsh -lc "o8 run -- sh -c \'npm test > artifacts/worker/npm-test.log 2>&1\'"'
      }
    },
    'expectedVerb': 'Ran tests',
    'exitCode': 130,
    'source': 'command_execution'
  },
  {
    'tool': {
      'name': 'exec_command',
      'args': {
        'command': '/bin/zsh -lc "o8 run -- bash -o pipefail -c \'npm test 2>&1 | tee artifacts/worker/npm-test-verified.log\'"'
      }
    },
    'expectedVerb': 'Ran tests',
    'exitCode': 0,
    'source': 'command_execution'
  },
  {
    'tool': {
      'name': 'exec_command',
      'args': {
        'command': '/bin/zsh -lc "o8 run -- bash -o pipefail -c \'NODE_OPTIONS=--max-old-space-size=12288 npx --no-install tsc --noEmit 2>&1 | tee artifacts/worker/tsc-committed.log\'"'
      }
    },
    'expectedVerb': 'Type-checked',
    'exitCode': 0,
    'source': 'command_execution'
  },
  {
    'tool': {
      'name': 'exec_command',
      'args': {
        'command': '/bin/zsh -lc \'npx tsc --noEmit\''
      }
    },
    'expectedVerb': 'Type-checked',
    'exitCode': 0,
    'source': 'command_execution'
  },
  {
    'tool': {
      'name': 'exec_command',
      'args': {
        'command': '/bin/zsh -lc \'npx eslint src/app/mobile\''
      }
    },
    'expectedVerb': 'Linted',
    'exitCode': 0,
    'source': 'command_execution'
  },
  {
    'tool': {
      'name': 'exec_command',
      'args': {
        'command': '/bin/zsh -lc \'npx eslint src/components/desktop/LLMChat.tsx\''
      }
    },
    'expectedVerb': 'Linted',
    'exitCode': 0,
    'source': 'command_execution'
  },
  {
    'tool': {
      'name': 'exec_command',
      'args': {
        'command': '/bin/zsh -lc \'git -C /workspace/project status --porcelain=v1; git -C /workspace/project status --porcelain=v1; git -C /workspace/project status --porcelain=v1; git diff --no-index -- /dev/null docs/free-and-open-plan.md\''
      }
    },
    'expectedVerb': 'Checked the diff',
    'exitCode': 1,
    'source': 'command_execution'
  },
  {
    'tool': {
      'name': 'exec_command',
      'args': {
        'command': '/bin/zsh -lc \'rg --files src/lib/util src/lib/utils 2>/dev/null || true\''
      }
    },
    'expectedVerb': 'Searched',
    'exitCode': 0,
    'source': 'command_execution'
  },
  {
    'tool': {
      'name': 'exec_command',
      'args': {
        'command': '/bin/zsh -lc "nl -ba src/lib/util/text.ts | sed -n \'1,40p\'"'
      }
    },
    'expectedVerb': 'Read',
    'exitCode': 0,
    'source': 'command_execution'
  },
  {
    'tool': {
      'name': 'apply_patch',
      'args': {
        'path': 'src/lib/orchestrator/worktree-cleanup.ts'
      }
    },
    'expectedVerb': 'Edited',
    'exitCode': 0,
    'source': 'file_change'
  }
];

// This catalog was collected across runs, not as one chronological turn.
// The acceptance preview arranges its unchanged samples into work phases.
// Actual transcripts always retain their original order.
export const phasedRecordedWorkerActivity = [
  0, 1, 2, 3, 4, 5, 16, 29,
  6, 7, 8, 9, 10, 28,
  11, 12, 13, 14, 27, 15, 17, 18,
  19, 20, 21, 22, 23, 24, 25, 26, 30,
].map(index => recordedWorkerActivity[index]);
