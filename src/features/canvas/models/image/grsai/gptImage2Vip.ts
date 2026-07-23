import type { ImageModelDefinition, ResolutionOption } from '../../types';
import { createGrsaiPointsPricing } from '@/features/canvas/pricing';

export const GRSAI_GPT_IMAGE_2_VIP_MODEL_ID = 'grsai/gpt-image-2-vip';

const ASPECT_RATIOS = [
  '1:1', '16:9', '9:16', '4:3', '3:4',
  '3:2', '2:3', '5:4', '4:5', '21:9',
  '9:21', '1:3', '3:1', '2:1', '1:2',
] as const;

const ALL_RESOLUTIONS: ResolutionOption[] = [
  { value: '1K', label: '1K' },
  { value: '2K', label: '2K' },
  { value: '4K', label: '4K' },
];

const LIMITED_RESOLUTIONS: ResolutionOption[] = [
  { value: '1K', label: '1K' },
  { value: '2K', label: '2K' },
];

function resolveVipResolutions(aspectRatio?: string): ResolutionOption[] {
  return (aspectRatio === '1:3' || aspectRatio === '3:1')
    ? LIMITED_RESOLUTIONS
    : ALL_RESOLUTIONS;
}

export const imageModel: ImageModelDefinition = {
  id: GRSAI_GPT_IMAGE_2_VIP_MODEL_ID,
  mediaType: 'image',
  displayName: 'GPT Image 2 VIP',
  providerId: 'grsai',
  description: 'GPT Image 2 VIP 图像生成与编辑（1K-4K）',
  eta: '30s',
  expectedDurationMs: 30000,
  defaultAspectRatio: '1:1',
  defaultResolution: '1K',
  aspectRatios: ASPECT_RATIOS.map((value) => ({ value, label: value })),
  resolutions: ALL_RESOLUTIONS,
  resolveResolutions: ({ aspectRatio }) => resolveVipResolutions(aspectRatio),
  pricing: createGrsaiPointsPricing(() => 1300),
  resolveRequest: ({ referenceImageCount }) => ({
    requestModel: GRSAI_GPT_IMAGE_2_VIP_MODEL_ID,
    modeLabel: referenceImageCount > 0 ? '编辑模式（VIP）' : '生成模式（VIP）',
  }),
};
