"""适配 UniSRec 权重，提供序列编码与推荐评分。结构与权重兼容实现参考 RUCAIBox UniSRec 和 RecBole（MIT，见 UNISREC_LICENSE.txt）。"""
import hashlib
import math
from pathlib import Path
import torch
from torch import nn
from torch.nn import functional as F

CHECKPOINT_SHA256 = '42da736452bed105bb04d2ac4f9d74c54b89d1a9c5115269f16d0d5a8cd92d9c'
CHECKPOINT_BYTES = 34981699
METADATA_GLOBALS = ['config.Config', 'unisrec.UniSRec', 'yaml.loader.FullLoader',
                    'recbole.utils.enum_type.ModelType', 'recbole.utils.enum_type.InputType',
                    'recbole.utils.enum_type.EvaluatorType']


class InertMetadata:
    def __init__(self, *values):
        self.values = values


def read_checkpoint(path):
    if tuple(int(v) for v in torch.__version__.split('+')[0].split('.')[:2]) < (2, 6):
        raise RuntimeError('Use isolated PyTorch >=2.6 with weights_only; never fall back to unrestricted pickle')
    path = Path(path)
    if path.stat().st_size != CHECKPOINT_BYTES or hashlib.sha256(path.read_bytes()).hexdigest() != CHECKPOINT_SHA256:
        raise ValueError('Official-download checkpoint digest mismatch')
    unknown = set(torch.serialization.get_unsafe_globals_in_checkpoint(path)) - set(METADATA_GLOBALS)
    if unknown:
        raise ValueError('Unexpected checkpoint globals: ' + str(sorted(unknown)))
    with torch.serialization.safe_globals([(InertMetadata, name) for name in METADATA_GLOBALS]):
        archive = torch.load(path, map_location='cpu', weights_only=True)
    state = archive['state_dict']
    if not state or any(not isinstance(t, torch.Tensor) or t.dtype != torch.float32 or not torch.isfinite(t).all() for t in state.values()):
        raise ValueError('Invalid checkpoint tensor dictionary')
    core = UniSRecCore()
    core.load_state_dict(state, strict=True)
    config = getattr(archive.get('config'), 'final_config_dict', {})
    description = {k: config.get(k) for k in ['hidden_size','inner_size','n_layers','n_heads','MAX_ITEM_LIST_LENGTH','hidden_dropout_prob','attn_dropout_prob','adaptor_dropout_prob','layer_norm_eps','n_exps','adaptor_layers','hidden_act','initializer_range']}
    expected = {'hidden_size':300,'inner_size':256,'n_layers':2,'n_heads':2,'MAX_ITEM_LIST_LENGTH':50,
                'hidden_dropout_prob':0.5,'attn_dropout_prob':0.5,'adaptor_dropout_prob':0.2,'layer_norm_eps':1e-12,'n_exps':8,'adaptor_layers':[768,300],'hidden_act':'gelu','initializer_range':0.02}
    if description != expected:
        raise ValueError('Checkpoint architecture differs from adapter: ' + str(description))
    return state, {'sha256':CHECKPOINT_SHA256,'bytes':CHECKPOINT_BYTES,'tensors':len(state),
                   'parameters':sum(t.numel() for t in state.values()),'configuration':description,
                   'metadataPolicy':'inert placeholders + weights_only; original Python classes never imported'}


class PWLayer(nn.Module):
    def __init__(self):
        super().__init__()
        self.dropout = nn.Dropout(0.2)
        self.bias = nn.Parameter(torch.zeros(768))
        self.lin = nn.Linear(768, 300, bias=False)

    def forward(self, x):
        return self.lin(self.dropout(x) - self.bias)


class MoEAdaptor(nn.Module):
    def __init__(self):
        super().__init__()
        self.w_gate = nn.Parameter(torch.zeros(768, 8))
        self.w_noise = nn.Parameter(torch.zeros(768, 8))
        self.experts = nn.ModuleList([PWLayer() for _ in range(8)])

    def forward(self, x):
        logits = x @ self.w_gate
        if self.training:
            logits = logits + torch.randn_like(logits) * (F.softplus(x @ self.w_noise) + 1e-2)
        outputs = torch.stack([expert(x) for expert in self.experts], dim=-2)
        return (logits.softmax(-1).unsqueeze(-1) * outputs).sum(-2)


class Attention(nn.Module):
    def __init__(self):
        super().__init__()
        self.query, self.key, self.value = (nn.Linear(300,300) for _ in range(3))
        self.dense = nn.Linear(300,300)
        self.LayerNorm = nn.LayerNorm(300,eps=1e-12)
        self.attn_dropout, self.out_dropout = nn.Dropout(0.5), nn.Dropout(0.5)

    def forward(self, x, mask):
        b,t,_ = x.shape
        q,k,v = [layer(x).reshape(b,t,2,150).transpose(1,2) for layer in [self.query,self.key,self.value]]
        weights = self.attn_dropout(((q @ k.transpose(-1,-2))/math.sqrt(150)+mask).softmax(-1))
        values = (weights @ v).transpose(1,2).reshape(b,t,300)
        return self.LayerNorm(x + self.out_dropout(self.dense(values)))


class FeedForward(nn.Module):
    def __init__(self):
        super().__init__()
        self.dense_1, self.dense_2 = nn.Linear(300,256), nn.Linear(256,300)
        self.LayerNorm, self.dropout = nn.LayerNorm(300,eps=1e-12), nn.Dropout(0.5)

    def forward(self, x):
        return self.LayerNorm(x + self.dropout(self.dense_2(F.gelu(self.dense_1(x), approximate='none'))))


class TransformerLayer(nn.Module):
    def __init__(self):
        super().__init__()
        self.multi_head_attention, self.feed_forward = Attention(), FeedForward()

    def forward(self, x, mask):
        return self.feed_forward(self.multi_head_attention(x,mask))


class TransformerEncoder(nn.Module):
    def __init__(self):
        super().__init__()
        self.layer = nn.ModuleList([TransformerLayer() for _ in range(2)])

    def forward(self, x, mask):
        for layer in self.layer:
            x = layer(x,mask)
        return x


class UniSRecCore(nn.Module):
    def __init__(self):
        super().__init__()
        self.position_embedding = nn.Embedding(50,300)
        self.trm_encoder = TransformerEncoder()
        self.LayerNorm, self.dropout = nn.LayerNorm(300,eps=1e-12), nn.Dropout(0.5)
        self.moe_adaptor = MoEAdaptor()
        self.apply(self._initialize)

    @staticmethod
    def _initialize(module):
        if isinstance(module,(nn.Linear,nn.Embedding)):
            nn.init.normal_(module.weight,mean=0,std=0.02)
            if isinstance(module,nn.Linear) and module.bias is not None:
                nn.init.zeros_(module.bias)

    def encode_sequence(self, adapted, lengths):
        b,t,_ = adapted.shape
        if t>50 or lengths.shape!=(b,) or (lengths<1).any() or (lengths>t).any():
            raise ValueError('Invalid sequence length')
        positions = torch.arange(t,device=adapted.device)
        x = self.dropout(self.LayerNorm(adapted + self.position_embedding(positions)))
        keys = positions[None,:] < lengths[:,None]
        causal = positions[:,None] >= positions[None,:]
        mask = (~(keys[:,None,None,:] & causal[None,None,:,:])).to(x.dtype) * -10000.0
        encoded = self.trm_encoder(x,mask)
        return F.normalize(encoded[torch.arange(b,device=x.device),lengths-1],dim=-1)


class AdaptedUniSRec(nn.Module):
    def __init__(self,state=None,freeze_encoder=True):
        super().__init__()
        self.core = UniSRecCore()
        if state is not None:
            self.core.load_state_dict(state,strict=True)
        self.bridge = nn.Sequential(nn.Linear(608,768),nn.LayerNorm(768))
        self.bias = nn.Parameter(torch.zeros(()))
        if freeze_encoder:
            self.core.position_embedding.requires_grad_(False)
            self.core.trm_encoder.requires_grad_(False)

    def user_embedding(self,sequence,lengths):
        return self.core.encode_sequence(self.core.moe_adaptor(self.bridge(sequence)),lengths)

    def item_embedding(self,item):
        return F.normalize(self.core.moe_adaptor(self.bridge(item)),dim=-1)

    def forward(self,sequence,lengths,item):
        return 4.0*(self.user_embedding(sequence,lengths)*self.item_embedding(item)).sum(-1)+self.bias
