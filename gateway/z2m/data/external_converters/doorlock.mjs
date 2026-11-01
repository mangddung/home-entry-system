// DoorL Zigbee 도어락(esp32/main/transport_zigbee.c) 외부 컨버터 — Zigbee2MQTT 2.14.2
// 앱 프로토콜 메시지를 MQTT로 중계만 한다. 해석·권한 체크는 서버(server/mqtt_worker.py)가 한다.
//   기기 → MQTT: homes/<gw>/<ieee>      {"doorlock_req": "<hex [type][seq][data]>"}
//   MQTT → 기기: homes/<gw>/<ieee>/set  {"doorlock_rsp": "<hex [type][seq][data]>"}
// 커스텀 클러스터 0xFC00, 명령 0x00 (양방향), 파라미터 하나 = octet string.
import {Zcl} from "zigbee-herdsman";
import * as m from "zigbee-herdsman-converters/lib/modernExtend";

const CLUSTER = "doorlockApp";
const HEX_MSG = /^(?:[0-9a-f]{2}){2,50}$/;

const fzDeviceMsg = {
    cluster: CLUSTER,
    type: ["commandDeviceMsg"],
    convert: (model, msg) => ({doorlock_req: msg.data.data.toString("hex")}),
};

const tzServerMsg = {
    key: ["doorlock_rsp"],
    convertSet: async (entity, key, value) => {
        if (typeof value !== "string" || !HEX_MSG.test(value)) throw new Error("invalid doorlock_rsp");
        await entity.command(CLUSTER, "serverMsg", {data: Buffer.from(value, "hex")}, {disableDefaultResponse: true});
    },
};

export default {
    zigbeeModel: ["doorl-zb-v1"],
    model: "doorl-zb-v1",
    vendor: "DoorL",
    description: "DoorL smart door lock (Zigbee model)",
    extend: [
        m.deviceAddCustomCluster(CLUSTER, {
            name: CLUSTER,
            ID: 0xfc00,
            attributes: {
                protocolVersion: {name: "protocolVersion", ID: 0x0000, type: Zcl.DataType.UINT8},
            },
            commands: {
                serverMsg: {name: "serverMsg", ID: 0x00, parameters: [{name: "data", type: Zcl.DataType.OCTET_STR}]},
            },
            commandsResponse: {
                deviceMsg: {name: "deviceMsg", ID: 0x00, parameters: [{name: "data", type: Zcl.DataType.OCTET_STR}]},
            },
        }),
    ],
    fromZigbee: [fzDeviceMsg],
    toZigbee: [tzServerMsg],
    exposes: [],
};
