/** Fresh selections only; retained installations keep their recorded addresses. */
export function selectServerPorts(record, isTaken, explicitPorts = [], out = () => {}) {
  const reserved = new Set([3051]);
  for (const key of ['port', 'coworkPort', 'messengerPort']) {
    const preferred = record[key];
    let selected = preferred;
    while (reserved.has(selected) || isTaken(selected)) {
      if (explicitPorts.includes(key)) throw Error(`Requested ${key} ${preferred} is unavailable; select another explicit port`);
      selected++;
      if (selected > 65535) throw Error(`No free loopback port available for ${key}`);
    }
    reserved.add(selected);
    record[key] = selected;
    if (selected !== preferred) out(`${key}: ${preferred} is unavailable; selected loopback port ${selected}`);
  }
  return record;
}
