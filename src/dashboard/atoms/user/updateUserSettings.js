import { normalizeUserDataToObject } from './normalizeUserDataToObject.js';

export async function updateUserSettings(userGateway, userId, settings) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const snapshot = await userGateway.getUserDataSnapshot(userId);
        const userData = normalizeUserDataToObject(snapshot.data);
        userData.__settings__ = settings;
        if (await userGateway.compareAndPutUserDataString(userId, snapshot, JSON.stringify(userData))) return true;
    }
    return false;
}
