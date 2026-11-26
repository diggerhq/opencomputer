//! `opc`: the terminal for your computer.
// Errors are the cold path; a boxed Error would cost every caller a
// deref for nothing measurable.
#![allow(clippy::result_large_err)]

pub mod api;
pub mod cache;
pub mod cli;
pub mod cmd;
pub mod config;
pub mod error;
pub mod http;
pub mod ids;
pub mod log;
pub mod net;
pub mod render;
pub mod telemetry;
pub mod timing;
pub mod wire;
pub mod ui;
