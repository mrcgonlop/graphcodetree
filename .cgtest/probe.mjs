import { S } from '../web/refactor/app/state.js';
import { buildElements } from '../web/refactor/app/builder.js';
console.log('ESM-in-place OK. nodeSize=', S.nodeSize, 'builder=', typeof buildElements);
