
const Ajv = require('ajv/dist/2020');
const addFormats = require('ajv-formats');
const fs = require('fs');

const schema = JSON.parse(fs.readFileSync('./src/schemas/universal.json', 'utf8'));

const ajv = new Ajv({ allErrors: true });
addFormats(ajv);

const validate = ajv.compile(schema);

console.log("Testing null...");
try {
    validate(null);
    console.log("null ok", validate.errors);
} catch (e) {
    console.log("null crashed", e.message);
}

console.log("Testing undefined...");
try {
    validate(undefined);
    console.log("undefined ok", validate.errors);
} catch (e) {
    console.log("undefined crashed", e.message);
}

console.log("Testing empty object...");
try {
    validate({});
    console.log("empty ok", validate.errors);
} catch (e) {
    console.log("empty crashed", e.message);
}
