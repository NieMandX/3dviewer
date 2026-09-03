import assert from 'node:assert/strict';
import { assignBuildingHeights, buildingAddressKey, readBuildingHeight, loadHeightBindings, saveHeightBindings } from '../modules/geo/building-heights.js';

export function runBuildingHeightMatchingSmoke() {
    const key = (number, street = 'улица Тестовая') => buildingAddressKey('Москва', street, number);
    assert.equal(key('33 ст1'), key('33 с1', 'Тестовая улица'));
    assert.equal(key('31 к2 ст1'), key('31 корпус 2 строение 1'));
    assert.equal(key('6Б'), key('6б'));
    assert.notEqual(key('33 к1'), key('33 с1'));
    assert.notEqual(key('33'), key('33 с1'));
    assert.notEqual(key('1/18'), key('18/1'));
    assert.equal(key('33, 34'), null);
    assert.equal(readBuildingHeight({ height: '143' }).top, 143);
    assert.equal(readBuildingHeight({ 'building:levels': '9' }).top, 27);
    assert.equal(readBuildingHeight({ height: '100 ft' }).top, 30.48);
    assert.equal(readBuildingHeight({ height: '143;260' }), null);
    assert.equal(readBuildingHeight({ 'building:levels': '5.5' }), null);
    assert.equal(readBuildingHeight({ height: '5', min_height: '6' }), null);
    assert.equal(readBuildingHeight({ height: '300', 'building:levels': '79' }).source, 'height');
    const address = key('1 с1');
    const contours = ['first', 'second'].map((id) => ({ id, addresses: [address] }));
    const elements = [143, 260].map((height, i) => ({ type: 'way', id: 10 + i,
        tags: { building: 'office', 'addr:street': 'Тестовая улица', 'addr:housenumber': '1 ст1', height: String(height) } }));
    const first = assignBuildingHeights(contours, elements);
    assert.deepEqual(first.contours.map((c) => c.height.top), [143, 260]);
    assert.equal(first.contours.every((c) => c.byOrder), true);
    const reordered = assignBuildingHeights([...contours].reverse(), [...elements].reverse(), first.bindings);
    assert.deepEqual(reordered.contours.map((c) => c.height.top), [260, 143]);
    assert.deepEqual(assignBuildingHeights(contours.slice(0, 1), elements).contours.map((c) => c.height), [null]);
    assert.deepEqual(assignBuildingHeights(contours, elements.slice(0, 1), first.bindings).contours.map((c) => c.height), [null, null]);
    const incomplete = structuredClone(elements);
    delete incomplete[0].tags.height;
    assert.deepEqual(assignBuildingHeights(contours, incomplete).contours.map((c) => c.height?.top ?? null), [null, 260]);
    const foreign = structuredClone(elements);
    foreign.forEach((e) => { e.tags['addr:city'] = 'Тула'; });
    assert.ok(assignBuildingHeights(contours, foreign).contours.every((c) => !c.height));
    assert.equal(assignBuildingHeights(contours, [...elements, elements[0]]).contours[0].height.top, 143);
    assert.ok(assignBuildingHeights([{ id: 'none', addresses: [] }], elements).contours.every((c) => !c.height));
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    let raw = '';
    try {
        Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
            getItem: () => raw, setItem: (_, value) => { raw = value; },
        } });
        saveHeightBindings(first.bindings);
        assert.deepEqual([...loadHeightBindings()], [...first.bindings]);
        saveHeightBindings(new Map(Array.from({ length: 1005 }, (_, i) => [String(i), `way/${i}`])));
        assert.equal(loadHeightBindings().size, 1000);
        raw = 'broken json';
        assert.equal(loadHeightBindings().size, 0);
        Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('Storage denied'); } });
        assert.equal(loadHeightBindings().size, 0);
        assert.doesNotThrow(() => saveHeightBindings(first.bindings));
    } finally {
        if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
        else delete globalThis.localStorage;
    }
}
