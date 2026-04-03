declare module '@phosphor-icons/react/dist/defs/*.es.js' {
  import type { IconWeight } from '@phosphor-icons/react';
  import type { ReactElement } from 'react';

  const defs: Map<IconWeight, ReactElement>;
  export default defs;
}
