import { Delivery } from 'iconoir-react';
import { SymonMark } from '../dictation/SymonVisuals';
import type { LucideIcon } from '../lucide-shims';

export const SymonIcon: LucideIcon = ({ size = 17 }) => <SymonMark size={Number(size)} />;
export const ProjectIcon: LucideIcon = ({ size = 24, strokeWidth = 2, color = 'currentColor' }) => (
  <Delivery width={size} height={size} strokeWidth={Number(strokeWidth)} color={color} />
);
