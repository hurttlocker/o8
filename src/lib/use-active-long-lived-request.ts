'use client';

import { useEffect, useState } from 'react';
import {
  createActiveLongLivedRequestController,
  type ActiveLongLivedRequestController,
} from '@/lib/active-long-lived-request';

export function useActiveLongLivedRequest(active: boolean): ActiveLongLivedRequestController {
  const [controller] = useState(() => createActiveLongLivedRequestController(active));

  useEffect(() => {
    controller.setActive(active);
  }, [active, controller]);

  useEffect(() => () => controller.abort('unmount'), [controller]);

  return controller;
}
