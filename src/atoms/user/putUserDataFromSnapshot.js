export async function putUserDataFromSnapshot(userGateway, userId, snapshot, dataString) {
    if (!await userGateway.compareAndPutUserDataString(userId, snapshot, dataString)) {
        const error = new Error('User data changed concurrently; retry the request');
        error.code = 'USER_DATA_CONFLICT';
        throw error;
    }
}
