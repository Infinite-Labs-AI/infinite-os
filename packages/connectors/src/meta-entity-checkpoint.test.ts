import {expect,it} from 'vitest';
import {metaEntityReadMode} from './meta-entity-checkpoint.js';
it('bootstraps a full scan and periodically reconciles removals',()=>{
 const now=new Date('2026-09-18T18:00:00Z');
 expect(metaEntityReadMode(null,null,now).mode).toBe('full');
 expect(metaEntityReadMode('2026-09-18T17:59:00Z','2026-09-17T17:00:00Z',now).mode).toBe('full');
 expect(metaEntityReadMode('2026-09-19T17:59:00Z','2026-09-18T17:00:00Z',now).mode).toBe('full');
});
it('requests only changes since the prior completed start, with overlap',()=>{
 expect(metaEntityReadMode('2026-09-18T17:50:00Z','2026-09-18T10:00:00Z',new Date('2026-09-18T18:00:00Z'))).toEqual({mode:'incremental',updatedSince:Date.parse('2026-09-18T17:45:00Z')/1000,startedAt:'2026-09-18T18:00:00.000Z'});
});
