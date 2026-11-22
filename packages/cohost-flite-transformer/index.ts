import type { AppDefinition } from "@w6w/types";
import cohostToFlite from "./actions/cohost-to-flite.ts";
import cohostToFliteData from "./actions/cohost-to-flite-data.ts";
import fliteToCohost from "./actions/flite-to-cohost.ts";
import transformOrder from "./actions/transform-order.ts";
import eventSnapshot from "./actions/event-snapshot.ts";
import listMappingObjects from "./actions/list-mapping-objects.ts";
import channelEventToFlite from "./actions/channel-event-to-flite.ts";
import orderImportPages from "./actions/order-import-pages.ts";
import orderImportFlatten from "./actions/order-import-flatten.ts";

/** Pure transformations. Fetch and write through the separately connected API apps. */
export default {
  actions: [fliteToCohost, cohostToFliteData, cohostToFlite, transformOrder, eventSnapshot, listMappingObjects, channelEventToFlite, orderImportPages, orderImportFlatten],
} satisfies AppDefinition;
