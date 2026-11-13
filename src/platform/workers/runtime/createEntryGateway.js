import {
    fetchIndexDo,
    fetchAsset,
    getUserByPathFromIndexDo,
    getUserByIdFromIndexDo,
    forwardRequestToUserDoSubStore,
    getSettingsFromIndexDo,
    listUsersFromIndexDo,
    patchSettingsToIndexDo,
    triggerUserCron,
} from './bindings.js';
import { createEntryGateway } from '../../../runtime/gateways/entryGateway.js';

export function createEntryGatewayForWorkers({ env }) {
    return createEntryGateway({
        async forwardDashboardApi({ request, requestId }) {
            return await fetchIndexDo({ request, env, requestId });
        },

        async fetchDashboardAsset({ requestOrUrl }) {
            return await fetchAsset({ requestOrUrl, env });
        },

        async getUserByPath({ userPath, requestId }) {
            return await getUserByPathFromIndexDo({ env, userPath, requestId });
        },

        async getUserById({ userId, requestId }) {
            return await getUserByIdFromIndexDo({ env, userId, requestId });
        },

        async forwardSubStoreRequest({ request, user, requestId, preservePath }) {
            return await forwardRequestToUserDoSubStore({ request, env, user, requestId, preservePath });
        },

        async getSettings({ requestId }) {
            return await getSettingsFromIndexDo({ env, requestId });
        },

        async listUsers({ afterId, limit, requestId }) {
            return await listUsersFromIndexDo({ env, afterId, limit, requestId });
        },

        async patchSettings({ patch, requestId }) {
            return await patchSettingsToIndexDo({ env, patch, requestId });
        },

        async triggerUserCron({ user, requestId }) {
            return await triggerUserCron({ env, user, requestId });
        },
    });
}
