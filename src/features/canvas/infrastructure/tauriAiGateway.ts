import {
  generateImage,
  getGenerateImageJob,
  listResumableGenerationJobs,
  setApiKey,
  submitGenerateImageJob,
  type ResumableJob,
} from '@/commands/ai';
import { persistImageLocally, isLikelyLocalImagePath } from '@/features/canvas/application/imageData';
import { uploadImageToVolcVod } from '@/commands/image';

import type { AiGateway, GenerateImagePayload } from '../application/ports';
import { logger } from '@/lib/logger';

/**
 * 上传本地图片到火山 VOD 点播空间，返回公网直链
 */
async function uploadImageToVolcVodBackend(imagePath: string): Promise<string> {
  logger.info('[VolcVOD] Uploading image to VOD via backend:', imagePath);
  return await uploadImageToVolcVod(imagePath);
}

async function normalizeReferenceImages(payload: GenerateImagePayload): Promise<string[] | undefined> {
  const isKieModel = payload.model.startsWith('kie/');
  const isFalModel = payload.model.startsWith('fal/');
  const isRunninghubModel = payload.model.startsWith('runninghub/');
  // Video models need HTTP public URLs - if local path, upload to VOD
  // Check both volcvideo/ prefix and doubao-seedance model name (for compatibility with stored model values without prefix)
  const isVideoModel = payload.model.startsWith('volcvideo/') || payload.model.includes('doubao-seedance');
  logger.info('[normalizeReferenceImages] model:', payload.model, 'isVideoModel:', isVideoModel, 'referenceImages count:', payload.referenceImages?.length ?? 0);
  if (payload.referenceImages) {
    payload.referenceImages.forEach((img, i) => {
      logger.info('[normalizeReferenceImages] image[{}] original: {}...', i, img.substring(0, 100));
      logger.info('[normalizeReferenceImages] image[{}] isLikelyLocalImagePath:', i, isLikelyLocalImagePath(img));
    });
  }
  return payload.referenceImages
    ? await Promise.all(
      payload.referenceImages.map(async (imageUrl, index) =>
        isKieModel || isFalModel || isRunninghubModel
          ? imageUrl // KIE/FAL/RunningHub 使用 data URL（后端会上传到服务器）
          : isVideoModel
          ? isLikelyLocalImagePath(imageUrl)
            ? (logger.info('[normalizeReferenceImages] image[' + index + '] uploading to VOD...'), await uploadImageToVolcVodBackend(imageUrl)) // 视频模型需要公网直链，上传到火山 VOD
            : (logger.info('[normalizeReferenceImages] image[' + index + '] using as-is (not local path)'), imageUrl) // 已经是公网直链，直接使用
          : isLikelyLocalImagePath(imageUrl)
            ? (logger.info('[normalizeReferenceImages] image[' + index + '] already local, skip persist'), imageUrl) // 已经在 uploads/ 下，跳过重复持久化
            : await persistImageLocally(imageUrl, payload.projectId)
      )
    )
    : undefined;
}

export const tauriAiGateway: AiGateway = {
  setApiKey,
  generateImage: async (payload: GenerateImagePayload) => {
    const normalizedReferenceImages = await normalizeReferenceImages(payload);

    return await generateImage({
      prompt: payload.prompt,
      model: payload.model,
      size: payload.size,
      aspect_ratio: payload.aspectRatio,
      reference_images: normalizedReferenceImages,
      extra_params: payload.extraParams,
      draftTaskId: payload.draftTaskId,
    });
  },
  submitGenerateImageJob: async (payload: GenerateImagePayload) => {
    const normalizedReferenceImages = await normalizeReferenceImages(payload);
    if (normalizedReferenceImages) {
      normalizedReferenceImages.forEach((img, i) => {
        logger.info('[submitGenerateImageJob] normalized image[{}]: {}...', i, img.substring(0, 100));
      });
    }
    return await submitGenerateImageJob({
      prompt: payload.prompt,
      model: payload.model,
      size: payload.size,
      aspect_ratio: payload.aspectRatio,
      reference_images: normalizedReferenceImages,
      extra_params: payload.extraParams,
      draftTaskId: payload.draftTaskId,
      project_id: payload.projectId,
    });
  },
  getGenerateImageJob,
  listResumableGenerationJobs: async (): Promise<ResumableJob[]> => {
    return await listResumableGenerationJobs();
  },
};
