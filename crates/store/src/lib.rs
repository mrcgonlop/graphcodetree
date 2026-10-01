//! Versioned in-memory graph store — the single source of truth for the
//! enriched graph. Owns interning, delta application, and query APIs.
//!
//! # Data flow
//!
//! ```text
//! extractor → KeyOp[] → store.ingest() → GraphDelta (for broadcast)
//!                                        → internal state updated
//!                                ┌──────┘
//!                                ▼
//! enricher  →  store queries  →  Vec<GraphOp>  →  store.apply()
//!                                                    │
//!                                                    ▼
//!                                               GraphDelta (for broadcast)
//! ```

mod intern;
pub use intern::Interner;

use cg_ir::{
    Edge, EdgeId, EdgeKey, EdgeKind, GraphDelta, GraphOp, ImportRecord, KeyOp, ModDecl,
    Node, NodeId, NodeKey, NodeKind, Version, ViewSpec,
};
use std::collections::HashMap;

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("version mismatch: base={base}, current={current}")]
    VersionMismatch { base: Version, current: Version },
    #[error("unknown node id {0}")] UnknownNode(NodeId),
    #[error("unknown edge id {0}")] UnknownEdge(EdgeId),
}

#[derive(Debug)]
pub struct GraphStore {
    version: Version,
    nodes: HashMap<NodeId, Node>,
    edges: HashMap<EdgeId, Edge>,
    interner: Interner,
    imports: HashMap<std::path::PathBuf, Vec<ImportRecord>>,
    mod_decls: HashMap<std::path::PathBuf, Vec<ModDecl>>,
    by_kind: HashMap<NodeKind, Vec<NodeId>>,
    out_edges: HashMap<NodeId, Vec<EdgeId>>,
    in_edges: HashMap<NodeId, Vec<EdgeId>>,
}

impl GraphStore {
    pub fn new() -> Self {
        Self {
            version: 0, nodes: HashMap::new(), edges: HashMap::new(),
            interner: Interner::new(), imports: HashMap::new(),
            mod_decls: HashMap::new(), by_kind: HashMap::new(),
            out_edges: HashMap::new(), in_edges: HashMap::new(),
        }
    }

    // ─── Ingestion ───────────────���───────────────────────
    pub fn ingest(&mut self, base_version: Version, ops: &[KeyOp],
        file_imports: &[(std::path::PathBuf, Vec<ImportRecord>)],
        file_mods: &[(std::path::PathBuf, Vec<ModDecl>)],
    ) -> Result<GraphDelta, StoreError> {
        if base_version != self.version {
            return Err(StoreError::VersionMismatch{base:base_version,current:self.version});
        }
        for(p,r)in file_imports{self.imports.insert(p.clone(),r.clone());}
        for(p,d)in file_mods{self.mod_decls.insert(p.clone(),d.clone());}
        let mut out=Vec::with_capacity(ops.len());
        for op in ops{match op{
            KeyOp::UpsertNode{key,spec}=>{
                let id=self.interner.intern_node(key);
                let n=Node{id,kind:spec.kind,label:spec.label.clone(),
                    ast_kind:spec.ast_kind.clone(),span:spec.span.clone(),
                    is_definition:spec.is_definition,attrs:spec.attrs.clone()};
                self.nodes.insert(id,n.clone());self.by_kind.entry(spec.kind).or_default().push(id);
                out.push(GraphOp::UpsertNode(n));
            }
            KeyOp::RemoveNode{key}=>{
                if let Some(id)=self.interner.node_id(key){
                    self.nodes.remove(&id);self.interner.remove_node(key);
                    self.by_kind.retain(|_,ids|{ids.retain(|&i|i!=id);!ids.is_empty()});
                    self.out_edges.remove(&id);self.in_edges.remove(&id);
                }
                out.push(GraphOp::RemoveNode{id:NodeId(0)});
            }
            KeyOp::UpsertEdge{key,spec}=>{
                let Some(sid)=self.interner.node_id(&key.source)else{
                    self.interner.intern_node(&key.source);continue;
                };
                let Some(tid)=self.interner.node_id(&key.target)else{
                    self.interner.intern_node(&key.target);continue;
                };
                let id=self.interner.intern_edge(key);
                let e=Edge{id,kind:key.kind,source:sid,target:tid,
                    span:spec.span.clone(),weight:spec.weight};
                self.edges.insert(id,e.clone());
                self.out_edges.entry(sid).or_default().push(id);
                self.in_edges.entry(tid).or_default().push(id);
                out.push(GraphOp::UpsertEdge(e));
            }
            KeyOp::RemoveEdge{key}=>{
                if let Some(id)=self.interner.edge_id(key){
                    if self.edges.remove(&id).is_some(){
                        self.out_edges.retain(|_,ids|{ids.retain(|&e|e!=id);!ids.is_empty()});
                        self.in_edges.retain(|_,ids|{ids.retain(|&e|e!=id);!ids.is_empty()});
                    }
                    self.interner.remove_edge(key);
                }
                out.push(GraphOp::RemoveEdge{id:EdgeId(0)});
            }
        }}
        for op in&mut out{
            if let GraphOp::UpsertEdge(ref mut e)=op{
                if self.interner.lookup_node(e.source).is_none()||self.interner.lookup_node(e.target).is_none(){
                    if let Some(k)=self.interner.lookup_edge(e.id){
                        if let(Some(s),Some(t))=(self.interner.node_id(&k.source),self.interner.node_id(&k.target)){
                            let u=Edge{source:s,target:t,..e.clone()};
                            self.edges.insert(e.id,u.clone());*e=u;
                        }
                    }
                }
            }
        }
        self.version+=1;
        Ok(GraphDelta{base_version:base_version,version:self.version,ops:out})
    }

    // ─── Apply (for enrichment deltas) ────────────────────
    pub fn apply(&mut self, delta: &GraphDelta) -> Result<GraphDelta, StoreError> {
        if delta.base_version != self.version {
            return Err(StoreError::VersionMismatch{base:delta.base_version,current:self.version});
        }
        let mut out = Vec::with_capacity(delta.ops.len());
        for op in &delta.ops { match op {
            GraphOp::UpsertNode(node) => {
                self.interner.intern_node(&NodeKey::Symbol{
                    lang:cg_ir::Lang::Rust,file:std::path::PathBuf::new(),
                    qualified_name:node.label.clone(),kind:node.kind,disambiguator:0});
                self.nodes.insert(node.id, node.clone());
                self.by_kind.entry(node.kind).or_default().push(node.id);
                out.push(GraphOp::UpsertNode(node.clone()));
            }
            GraphOp::UpsertEdge(edge) => {
                if !self.nodes.contains_key(&edge.source)||!self.nodes.contains_key(&edge.target){
                    continue;
                }
                self.edges.insert(edge.id, edge.clone());
                self.out_edges.entry(edge.source).or_default().push(edge.id);
                self.in_edges.entry(edge.target).or_default().push(edge.id);
                out.push(GraphOp::UpsertEdge(edge.clone()));
            }
            GraphOp::RemoveNode{id}=>{
                if self.nodes.remove(id).is_some(){
                    self.by_kind.retain(|_,ids|{ids.retain(|&i|i!=*id);!ids.is_empty()});
                    self.out_edges.remove(id);self.in_edges.remove(id);
                }
                out.push(GraphOp::RemoveNode{id:*id});
            }
            GraphOp::RemoveEdge{id}=>{
                if self.edges.remove(id).is_some(){
                    self.out_edges.retain(|_,ids|{ids.retain(|&e|e!=*id);!ids.is_empty()});
                    self.in_edges.retain(|_,ids|{ids.retain(|&e|e!=*id);!ids.is_empty()});
                }
                out.push(GraphOp::RemoveEdge{id:*id});
            }
            GraphOp::BeginSnapshot|GraphOp::EndSnapshot=>out.push(op.clone()),
        }}
        self.version+=1;
        Ok(GraphDelta{base_version:delta.base_version,version:self.version,ops:out})
    }

    // ─── Queries ──────────────────────────────────────────
    pub fn version(&self)->Version{self.version}
    pub fn node(&self,id:NodeId)->Option<&Node>{self.nodes.get(&id)}
    pub fn edge(&self,id:EdgeId)->Option<&Edge>{self.edges.get(&id)}
    pub fn lookup_node(&self,key:&NodeKey)->Option<NodeId>{self.interner.node_id(key)}
    /// Reverse-lookup: given a node ID, return its key.
    pub fn lookup_node_key(&self, id: NodeId) -> Option<&NodeKey> {
        self.interner.lookup_node(id)
    }
    pub fn lookup_edge(&self,key:&EdgeKey)->Option<EdgeId>{self.interner.edge_id(key)}
    pub fn edges_from(&self,id:NodeId)->Vec<&Edge>{
        self.out_edges.get(&id).map(|ids|ids.iter().filter_map(|e|self.edges.get(e)).collect()).unwrap_or_default()
    }
    pub fn edges_to(&self,id:NodeId)->Vec<&Edge>{
        self.in_edges.get(&id).map(|ids|ids.iter().filter_map(|e|self.edges.get(e)).collect()).unwrap_or_default()
    }
    pub fn edges_of_kind(&self,k:EdgeKind)->Vec<&Edge>{
        self.edges.values().filter(|e|e.kind==k).collect()
    }
    pub fn nodes_by_kind(&self,k:NodeKind)->Vec<&Node>{
        self.by_kind.get(&k).map(|ids|ids.iter().filter_map(|i|self.nodes.get(i)).collect()).unwrap_or_default()
    }
    pub fn all_nodes(&self)->Vec<&Node>{self.nodes.values().collect()}
    pub fn all_edges(&self)->Vec<&Edge>{self.edges.values().collect()}
    pub fn imports_for(&self,p:&std::path::Path)->Option<&[ImportRecord]>{
        self.imports.get(p).map(|v|v.as_slice())
    }
    pub fn mod_decls_for(&self,p:&std::path::Path)->Option<&[ModDecl]>{
        self.mod_decls.get(p).map(|v|v.as_slice())
    }
    pub fn lookup_qualified(&self,qn:&str)->Vec<(NodeId,&Node)>{
        self.nodes.iter().filter(|(_,n)|{
            self.interner.lookup_node(n.id).map(|key|
                matches!(key,NodeKey::Symbol{qualified_name,..}if qualified_name==qn)
            ).unwrap_or(false)
        }).map(|(&id,n)|(id,n)).collect()
    }

    pub fn to_snapshot(&self) -> cg_ir::Snapshot {
        let nodes:Vec<_>=self.nodes.values().filter(|n|n.is_definition).map(|n|{
            let file=self.interner.lookup_node(n.id).map(|k|match k{
                NodeKey::Symbol{file,..}=>file.clone(),
                NodeKey::Anchored{ancestor,..}=>match ancestor.as_ref(){
                    NodeKey::Symbol{file,..}=>file.clone(),_=>std::path::PathBuf::new()},
            }).unwrap_or_default();
            let key=self.interner.lookup_node(n.id).cloned().unwrap_or(
                NodeKey::Symbol{lang:cg_ir::Lang::Rust,file:file.clone(),
                    qualified_name:n.label.clone(),kind:n.kind,disambiguator:0});
            cg_ir::GraphNode{key,kind:n.kind,label:n.label.clone(),
                ast_kind:n.ast_kind.clone(),span:n.span.clone(),
                attrs:n.attrs.clone(),file,
                depth:n.attrs.extra.get("depth").and_then(|v|v.as_u64()).unwrap_or(0)as u32}
        }).collect();
        let edges:Vec<_>=self.edges.values().map(|e|{
            let sk=self.interner.lookup_node(e.source).cloned().unwrap_or(
                NodeKey::Symbol{lang:cg_ir::Lang::Rust,file:std::path::PathBuf::new(),
                    qualified_name:String::new(),kind:NodeKind::Function,disambiguator:0});
            let tk=self.interner.lookup_node(e.target).cloned().unwrap_or(
                NodeKey::Symbol{lang:cg_ir::Lang::Rust,file:std::path::PathBuf::new(),
                    qualified_name:String::new(),kind:NodeKind::Function,disambiguator:0});
            cg_ir::GraphEdge{kind:e.kind,source:sk,target:tk,
                span:e.span.clone(),weight:e.weight}
        }).collect();
        let nlen=nodes.len();let elen=edges.len();
        let mut fc = 0; let mut sc = 0; let mut tc = 0; let mut ic = 0;
        let mut cc = 0; let mut cntc = 0; let mut implc = 0; let mut dfc = 0;
        for n in &nodes{match n.kind{
            NodeKind::Function|NodeKind::Method=>fc+=1,
            NodeKind::Struct=>sc+=1,NodeKind::Trait=>tc+=1,
            NodeKind::ImplBlock=>ic+=1,_=>{}}
        }
        for e in&edges{match e.kind{
            EdgeKind::Calls=>cc+=1,
            EdgeKind::Contains=>cntc+=1,
            EdgeKind::Implements=>implc+=1,
            EdgeKind::DataFlow=>dfc+=1,
            _=>{}}
        }
        cg_ir::Snapshot{nodes,edges,file_count:self.imports.len(),
            stats:cg_ir::SnapshotStats{total_nodes:nlen,total_edges:elen,
                function_count:fc,struct_count:sc,trait_count:tc,impl_count:ic,
                calls_edge_count:cc,contains_edge_count:cntc,
                impl_edge_count:implc,data_flow_edge_count:dfc}}
    }

    pub fn snapshot(&self,view:&ViewSpec)->GraphDelta{
        let mut ops=vec![GraphOp::BeginSnapshot];
        for n in self.nodes.values(){
            let ik=view.node_kinds.is_empty()||view.node_kinds.contains(&n.kind);
            let ir=view.root.map_or(true,|r|n.id==r||self.is_descendant_of(n.id,r));
            if ik&&ir{ops.push(GraphOp::UpsertNode(n.clone()));}
        }
        for e in self.edges.values(){
            let ik=view.edge_kinds.is_empty()||view.edge_kinds.contains(&e.kind);
            if ik&&self.nodes.contains_key(&e.source)&&self.nodes.contains_key(&e.target){
                ops.push(GraphOp::UpsertEdge(e.clone()));
            }
        }
        ops.push(GraphOp::EndSnapshot);
        GraphDelta{base_version:self.version,version:self.version,ops}
    }

    fn is_descendant_of(&self,node_id:NodeId,ancestor_id:NodeId)->bool{
        let mut c=node_id;loop{
            let p:Vec<_>=self.edges_to(c).into_iter().filter(|e|e.kind==EdgeKind::Contains).collect();
            match p.first(){Some(e)if e.source==ancestor_id=>return true,Some(e)=>c=e.source,_=>return false,}
        }
    }

    pub fn node_count(&self)->usize{self.nodes.len()}
    pub fn edge_count(&self)->usize{self.edges.len()}
    pub fn interner(&self)->&Interner{&self.interner}
}

#[cfg(test)]
mod tests {
    use super::*;
    use cg_ir::{EdgeSpec, Lang, NodeAttrs, NodeSpec, Point, Span};

    fn mkfp(p:&str)->NodeKey{NodeKey::Symbol{lang:Lang::Rust,file:p.into(),
        qualified_name:String::new(),kind:NodeKind::File,disambiguator:0}}
    fn mkfn(p:&str,n:&str)->NodeKey{NodeKey::Symbol{lang:Lang::Rust,file:p.into(),
        qualified_name:n.into(),kind:NodeKind::Function,disambiguator:0}}
    fn mksp(f:&str)->Span{Span{file:f.into(),start_byte:0,end_byte:10,
        start:Point{row:0,col:0},end:Point{row:0,col:10}}}
    fn mkn(k:NodeKind,l:&str,d:bool)->NodeSpec{NodeSpec{kind:k,label:l.into(),
        ast_kind:"test".into(),span:Some(mksp("test.rs")),is_definition:d,
        attrs:NodeAttrs::default()}}
    fn mke(k:EdgeKind,w:u32)->EdgeSpec{EdgeSpec{kind:k,span:None,weight:w}}

    #[test]fn ingest_nodes_and_edges(){
        let mut s=GraphStore::new();
        let fk=mkfp("src/lib.rs");let fk2=mkfn("src/lib.rs","greet");
        let d=s.ingest(0,&[KeyOp::UpsertNode{key:fk.clone(),spec:mkn(NodeKind::File,"lib.rs",false)},
            KeyOp::UpsertNode{key:fk2.clone(),spec:mkn(NodeKind::Function,"greet",true)},
            KeyOp::UpsertEdge{key:EdgeKey{kind:EdgeKind::Contains,source:fk.clone(),
                target:fk2.clone(),ordinal:0},spec:mke(EdgeKind::Contains,1)}],&[],&[]).unwrap();
        assert_eq!(d.base_version,0);assert_eq!(d.version,1);
        assert_eq!(s.node_count(),2);assert_eq!(s.edge_count(),1);
        assert_eq!(s.node(s.lookup_node(&fk).unwrap()).unwrap().label,"lib.rs");
        assert_eq!(s.node(s.lookup_node(&fk2).unwrap()).unwrap().label,"greet");
    }

    #[test]fn ingest_with_imports(){
        let mut s=GraphStore::new();
        s.ingest(0,&[KeyOp::UpsertNode{key:mkfp("src/main.rs"),
            spec:mkn(NodeKind::File,"main.rs",false)}],
            &[(std::path::PathBuf::from("src/main.rs"),vec![ImportRecord{
                path:vec!["crate".into(),"greeter".into()],alias:None,
                glob:false,span:mksp("src/main.rs")}])],&[]).unwrap();
        assert_eq!(s.imports_for(std::path::Path::new("src/main.rs")).unwrap().len(),1);
    }

    #[test]fn apply_enrichment_delta(){
        let mut s=GraphStore::new();
        let fk=mkfp("src/lib.rs");let fk2=mkfn("src/lib.rs","hello");
        s.ingest(0,&[KeyOp::UpsertNode{key:fk.clone(),spec:mkn(NodeKind::File,"lib.rs",false)},
            KeyOp::UpsertNode{key:fk2.clone(),spec:mkn(NodeKind::Function,"hello",true)}],&[],&[]).unwrap();
        let fid=s.lookup_node(&fk).unwrap();let f2id=s.lookup_node(&fk2).unwrap();
        let r=s.apply(&GraphDelta{base_version:1,version:2,
            ops:vec![GraphOp::UpsertEdge(Edge{id:EdgeId(99),kind:EdgeKind::Calls,
                source:fid,target:f2id,span:None,weight:1})]}).unwrap();
        assert_eq!(r.version,2);assert_eq!(s.edge_count(),1);
    }

    #[test]fn version_mismatch_rejected(){
        assert!(GraphStore::new().ingest(42,&[KeyOp::UpsertNode{
            key:mkfp("src/lib.rs"),spec:mkn(NodeKind::File,"lib.rs",false)}],&[],&[]).is_err());
    }

    #[test]fn to_snapshot_produces_valid_output(){
        let mut s=GraphStore::new();
        let fk=mkfp("src/lib.rs");let fk2=mkfn("src/lib.rs","hello");
        s.ingest(0,&[KeyOp::UpsertNode{key:fk.clone(),spec:mkn(NodeKind::File,"lib.rs",false)},
            KeyOp::UpsertNode{key:fk2.clone(),spec:mkn(NodeKind::Function,"hello",true)},
            KeyOp::UpsertEdge{key:EdgeKey{kind:EdgeKind::Contains,source:fk.clone(),
                target:fk2.clone(),ordinal:0},spec:mke(EdgeKind::Contains,1)}],&[],&[]).unwrap();
        let snap=s.to_snapshot();
        assert_eq!(snap.nodes.len(),1);assert_eq!(snap.stats.function_count,1);
        assert_eq!(snap.stats.contains_edge_count,1);assert_eq!(snap.nodes[0].label,"hello");
    }
}
