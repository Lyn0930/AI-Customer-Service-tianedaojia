import { axiosForBackend } from '@lark-apaas/client-toolkit/utils/getAxiosForBackend';
import type { AiTestRequest, AiTestResponse } from '@shared/api.interface';

export async function runAiTest(payload: AiTestRequest): Promise<AiTestResponse> {
  const res = await axiosForBackend({
    url: '/api/test/call',
    method: 'POST',
    data: payload,
  });
  return res.data;
}
