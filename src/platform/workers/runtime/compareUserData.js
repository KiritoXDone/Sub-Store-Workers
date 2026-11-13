export async function compareAndPutUserDataInUserDo({ env, userId, snapshot, dataString }) {
    const id = env.USER_DO.idFromName(String(userId));
    const stub = env.USER_DO.get(id);
    const response = await stub.fetch('https://user/_internal/user-data', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-User-Id': String(userId) },
        body: JSON.stringify({ data: JSON.parse(dataString), expectedData: snapshot.data }),
    });
    if (response.status === 409) return false;
    if (!response.ok) throw new Error(`User data update failed: ${response.status}`);
    return true;
}
