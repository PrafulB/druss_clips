import {embedData,init as pipelineInit} from './embed.mjs'
import { Crosswalk, CodingSystem } from './crosswalk.mjs';
import { device, ort } from './env.js';
import { read_csv } from './io.mjs';

export {Crosswalk, CodingSystem}
export {read_csv}

let pipelineData = {
    "0.0.2": {
        model: "Xenova/GIST-small-Embedding-v0",
        model_url: `https://danielruss.github.io/soccer-models/clips_v0.0.2.onnx`,
        config: {
            dtype: "fp32",
            quantized: false,
            device: device,
        },
        embeddingConfig: {
            pooling: "cls",
            normalize: true,
        }
    }
}

let current_config=null;
export async function configureClips(version="0.0.2"){
    current_config = pipelineData['0.0.2'];
    console.log(`configure_clips: ${JSON.stringify(current_config)}`)
    await pipelineInit(current_config)
}

// the data is a json array where each line 
// has {products_services:"",sic1987:""} There can be unused keys.
export async function runClipsPipeline(data,{n=10}={}){
    if (!data) throw new Error("No data to classify");
    // Step 1. check the data
    data = cleanData(data)
    console.log(JSON.stringify(data,null,3))

    // Step 2. Feature Extraction:
    let embeded_ps = await embedData(data.products_services)
    const embedding_tensor = new ort.Tensor('float32',embeded_ps.data, embeded_ps.dims);

    // Step 3. Handle the crosswalking (naics2022 has 689 5-digit codes.)
    let sic1987_naics2022 = await Crosswalk.loadCrosswalk("sic1987","naics2022")
    let crosswalk_buffer = sic1987_naics2022.createBuffer(data.length)
    if (Object.hasOwn(data,"sic1987")){
        sic1987_naics2022.bufferedCrosswalk(data['sic1987'],crosswalk_buffer)
    }
    const crosswalk_tensor = new ort.Tensor('float32',crosswalk_buffer, crosswalk_buffer.dims);

    // Step 4. load the onnx model
    let current_model = current_config.model_url;
    current_model = await (await fetch(current_model)).arrayBuffer()
    const session= await ort.InferenceSession.create(current_model,{executionProviders: [device] })
    const feeds = {
        embedded_input: embedding_tensor,
        crosswalked_inp: crosswalk_tensor
    }
    // Step 5. run the onnx model
    let results = await session.run(feeds);

    // Step 6. process the results.
    results = onnxResultToArray(results.naics2022_out)

    // Step 7. get top N results...
    let naics2022 = await CodingSystem.loadCodingSystem('naics2022')
    results=results.map( (job)=>topK(job,n,naics2022) )

    return results
}

function cleanData(data){
    if (!Array.isArray(data)) data=[data];
    let npad=  Math.floor(Math.log10(data.length));
    let keys = Object.keys(data[0])
    let initial_object = keys.reduce( (obj,key) => {obj[key]=[];return obj},{})

    // transpose the data to a column array.
    let cleanedData =  data.reduce( (acc,cv,indx)=>{
        keys.forEach(k => acc[k].push(cv[k]))
        acc.length = indx+1
        return acc
    },initial_object)

    if (!Object.hasOwn(cleanedData,"Id")){
        cleanedData['Id'] = Array.from({length:cleanedData.length},(_,indx)=>`row-${Number(indx+1).toString().padStart(npad,"0")}`)
    }
    cleanedData['products_services'] = cleanedData['products_services'].map( ps => ps.toLowerCase())

    return cleanedData;
}

function onnxResultToArray(tensor) {
    console.log(tensor)
    const [rows, cols] = tensor.dims;
    const data = Array.from(tensor.cpuData);

    return Array.from({ length: rows }, (_, i) => data.slice(i * cols, i * cols + cols));
}

function topK(arr, k, codingSystem) {
    // Set k to the length of the array if k is greater than the array length
    k = Math.min(k, arr.length)

    // Create an array of indices and sort it based on the values in arr
    const indices = Array.from(arr.keys()).sort((a, b) => arr[b] - arr[a]);

    // Get the top k values and their indices
    const topIndices = indices.slice(0, k);
    const topValues = topIndices.map(i => arr[i]);

    const topObjects = codingSystem.fromIndices(topIndices)
    const {topCodes,topLabels} = topObjects.reduce( (acc,cv) =>{
        acc['topCodes'].push(cv.code)
        acc['topLabels'].push(cv.title)
        return acc
    },{topCodes:[],topLabels:[]})


    return { naics2022: topCodes, title: topLabels, score: topValues };
}